import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import webbrowser, os, tempfile, csv, re
from collections import namedtuple, defaultdict, OrderedDict
from math import ceil

try:
    import pandas as pd
    HAVE_PANDAS = True
except Exception:
    HAVE_PANDAS = False

APP_TITLE = "QuantStudio 5 — 384-well qPCR Planner (v5: pasted samples + Avg formulas)"
PLATE_ROWS = list("ABCDEFGHIJKLMNOP")    # 16 rows
PLATE_COLS = list(range(1, 25))          # 24 cols
WELLS_PER_ROW = len(PLATE_COLS)          # 24
WELLS_PER_PLATE = len(PLATE_ROWS) * len(PLATE_COLS)  # 384

# Per 15 µl reaction (13 µl master mix + 2 µl cDNA)
Chem = namedtuple("Chem", ["name", "per_sample"])
CHEMISTRY = {
    "SYBR": Chem("SYBR", {
        "2X master mix": 7.5,
        "RNAse-free H2O": 4.9,
        "10 µM probe": 0.0,
        "10 µM Forward": 0.3,
        "10 µM Reverse": 0.3
    }),
    "TaqMan": Chem("TaqMan", {
        "2X master mix": 7.5,
        "RNAse-free H2O": 4.6,
        "10 µM probe": 0.3,
        "10 µM Forward": 0.3,
        "10 µM Reverse": 0.3
    })
}
REACTION_VOL = 15.0
CDNA_PER_WELL = 2.0
MASTER_MIX_PER_WELL = REACTION_VOL - CDNA_PER_WELL  # 13 µl

DEFAULT_GENES = [
    ("Tnf", "TaqMan"),
    ("Ccl2", "SYBR"),
    ("Il1b", "SYBR"),
    ("Gapdh", "SYBR"),
]

HELP = (
    "Rules:\n"
    "• 384-well plate (A–P × 1–24)\n"
    "• Replicates are adjacent (left→right)\n"
    "• Each gene starts on a NEW row; if a gene ends mid-row, the rest of that row stays EMPTY\n"
    "• Within each gene the order is: Samples → Standards → (Pos if any) → RT− → RNA− → Blank\n"
    "• A gene's entire block MUST fit in a single plate (no splitting of that gene across plates)\n"
    "• Paste sample list as 'Name[tab/comma/space]Group' (Group optional). Order is preserved.\n"
    "• Mix overage is a PERCENTAGE that increases master-mix totals only (does NOT add wells)\n"
)

def letters_series(n):
    out = []
    i = 0
    while len(out) < n:
        out.append(chr(ord('A') + (i % 26)))
        i += 1
    return out[:n]

class GeneConfigFrame(ttk.Frame):
    def __init__(self, master, index, gene_name="", chemistry="SYBR"):
        super().__init__(master)
        self.idx = index
        self.gene_var = tk.StringVar(value=gene_name)
        self.chem_var = tk.StringVar(value=chemistry)
        ttk.Label(self, text=f"Gene {index+1}").grid(row=0, column=0, padx=4, pady=2, sticky="w")
        ttk.Entry(self, textvariable=self.gene_var, width=16).grid(row=0, column=1, padx=4, pady=2)
        ttk.Label(self, text="Chemistry").grid(row=0, column=2, padx=4, pady=2)
        ttk.Combobox(self, textvariable=self.chem_var, values=list(CHEMISTRY.keys()),
                     width=8, state="readonly").grid(row=0, column=3, padx=4, pady=2)

    def get(self):
        g = self.gene_var.get().strip()
        c = self.chem_var.get().strip()
        if not g: raise ValueError("Gene name cannot be empty.")
        if c not in CHEMISTRY: raise ValueError(f"Unknown chemistry for {g}.")
        return g, c

class PlateCanvas(ttk.Frame):
    """Scrollable, zoomable plate renderer."""
    def __init__(self, master):
        super().__init__(master, padding=4)
        self.pack(fill=tk.BOTH, expand=True)
        self.canvas = tk.Canvas(self, bg="white")
        xscroll = ttk.Scrollbar(self, orient="horizontal", command=self.canvas.xview)
        yscroll = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(xscrollcommand=xscroll.set, yscrollcommand=yscroll.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        yscroll.grid(row=0, column=1, sticky="ns")
        xscroll.grid(row=1, column=0, sticky="ew")
        self.grid_rowconfigure(0, weight=1)
        self.grid_columnconfigure(0, weight=1)

        ctl = ttk.Frame(self)
        ctl.grid(row=2, column=0, sticky="ew", pady=(6,0))
        ttk.Label(ctl, text="Plate:").pack(side=tk.LEFT)
        self.plate_var = tk.StringVar()
        self.plate_cb = ttk.Combobox(ctl, textvariable=self.plate_var, state="readonly", width=18)
        self.plate_cb.pack(side=tk.LEFT, padx=6)
        ttk.Label(ctl, text="Zoom:").pack(side=tk.LEFT)
        self.zoom_var = tk.DoubleVar(value=28.0)
        ttk.Scale(ctl, from_=18, to=42, orient="horizontal", variable=self.zoom_var,
                  command=lambda *_: self.redraw()).pack(side=tk.LEFT, padx=6, fill=tk.X, expand=True)

        self.plate_cb.bind("<<ComboboxSelected>>", lambda e: self.redraw())
        self.plates = {}   # name -> dict[(row,col)] = cell dict
        self.colors = {}   # gene -> color

    def set_data(self, plates, colors):
        self.colors = colors
        self.plates = {}
        for name, rows in plates.items():
            cellmap = {}
            for r in rows:
                well = r["Well"]
                row_letter = well[0]
                col = int(well[1:])
                ri = PLATE_ROWS.index(row_letter)
                ci = PLATE_COLS.index(col)
                cellmap[(ri, ci)] = r
            self.plates[name] = cellmap
        names = list(self.plates.keys())
        self.plate_cb["values"] = names
        if names:
            self.plate_var.set(names[0])
        self.redraw()

    def redraw(self):
        self.canvas.delete("all")
        if not self.plates or not self.plate_var.get():
            return
        name = self.plate_var.get()
        cells = self.plates[name]
        s = self.zoom_var.get()
        pad = s

        width = pad + WELLS_PER_ROW * s + 10
        height = pad + len(PLATE_ROWS) * s + 10
        self.canvas.config(scrollregion=(0, 0, width, height))

        # headers
        for j, col in enumerate(PLATE_COLS):
            x = pad + j*s + s/2
            self.canvas.create_text(x, pad/2, text=str(col), font=("Arial", int(s/3)))
        for i, row in enumerate(PLATE_ROWS):
            y = pad + i*s + s/2
            self.canvas.create_text(pad/2, y, text=row, font=("Arial", int(s/3)))

        # cells
        for i in range(len(PLATE_ROWS)):
            for j in range(WELLS_PER_ROW):
                x0 = pad + j*s; y0 = pad + i*s
                x1 = x0 + s;    y1 = y0 + s
                r = cells.get((i, j))
                if r:
                    color = self.colors.get(r["Gene"], "#dddddd")
                    self.canvas.create_rectangle(x0, y0, x1, y1, fill=color, outline="#777")
                    gene_txt = r["Gene"]
                    info = f'{r["Type"]}:{r["Label"]} r{r["Replicate"]}'
                    self.canvas.create_text((x0+x1)/2, y0 + 0.45*s, text=gene_txt, font=("Arial", int(s/3.4)))
                    self.canvas.create_text((x0+x1)/2, y0 + 0.78*s, text=info, font=("Arial", int(s/4.8)))
                else:
                    self.canvas.create_rectangle(x0, y0, x1, y1, fill="#ffffff", outline="#ccc")

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("1400x980")

        # --------- Top controls ----------
        top = ttk.Frame(self, padding=8)
        top.pack(side=tk.TOP, fill=tk.X)

        self.num_samples_var   = tk.IntVar(value=70)
        self.num_standards_var = tk.IntVar(value=8)
        self.num_pos_var       = tk.IntVar(value=0)    # default 0; add if you want positives
        self.num_reps_var      = tk.IntVar(value=2)
        self.overage_pct_var   = tk.DoubleVar(value=10.0)  # PERCENT overage for mix
        self.place_gapdh_separate_var = tk.BooleanVar(value=False)
        self.include_rtneg_var = tk.BooleanVar(value=True)
        self.include_rnaneg_var= tk.BooleanVar(value=True)

        row1 = ttk.Frame(top); row1.pack(fill=tk.X)
        for lbl, var, w in [
            ("# Samples", self.num_samples_var, 7),
            ("# Standards", self.num_standards_var, 7),
            ("# Pos ctrls", self.num_pos_var, 7),
            ("# Replicates", self.num_reps_var, 6),
            ("Mix overage (%)", self.overage_pct_var, 6),
        ]:
            ttk.Label(row1, text=lbl).pack(side=tk.LEFT, padx=(0,4))
            ttk.Entry(row1, textvariable=var, width=w, name=f"entry_{lbl.replace(' ','_')}").pack(side=tk.LEFT, padx=(0,16))

        ttk.Checkbutton(row1, text="Place GAPDH on separate plate",
                        variable=self.place_gapdh_separate_var).pack(side=tk.LEFT, padx=8)
        ttk.Checkbutton(row1, text="Include RT− control",
                        variable=self.include_rtneg_var).pack(side=tk.LEFT, padx=8)
        ttk.Checkbutton(row1, text="Include RNA− control",
                        variable=self.include_rnaneg_var).pack(side=tk.LEFT, padx=8)

        ttk.Button(top, text="Compute Layout & Mix", command=self.compute).pack(side=tk.RIGHT, padx=8)

        # --------- Samples paste box ----------
        paste_box = ttk.LabelFrame(self, text="Samples (optional paste; order preserved)", padding=8)
        paste_box.pack(fill=tk.X, padx=8, pady=(8,0))

        self.use_pasted_samples_var = tk.BooleanVar(value=False)
        self.sample_text = tk.Text(paste_box, height=6, wrap="none")
        self.sample_text.insert("1.0",
            "Paste: Name[tab/comma/space]Group (Group optional), one per line.\n"
            "Example:\n321\told age\nC577\tmiddle age\nC5711\tmiddle age\n")
        self.sample_text.configure(state="disabled")

        def toggle_samples():
            use = self.use_pasted_samples_var.get()
            # enable/disable text + #Samples entry
            self.sample_text.configure(state=("normal" if use else "disabled"))
            entry = self.nametowidget(".!frame.entry_#_Samples")
            state = ("disabled" if use else "normal")
            try:
                entry.configure(state=state)
            except Exception:
                pass

        ttk.Checkbutton(paste_box, text="Use pasted sample list",
                        variable=self.use_pasted_samples_var,
                        command=toggle_samples).pack(side=tk.LEFT, padx=(0,12))
        self.sample_text.pack(fill=tk.X, expand=True, padx=(0,4))

        # --------- Genes box ----------
        self.gene_box = ttk.LabelFrame(self, text="Genes & Chemistry", padding=8)
        self.gene_box.pack(fill=tk.X, padx=8, pady=(8,8))
        self.gene_frames = []
        for i, (g, chem) in enumerate(DEFAULT_GENES):
            gf = GeneConfigFrame(self.gene_box, i, g, chem); gf.pack(anchor="w")
            self.gene_frames.append(gf)
        gr = ttk.Frame(self.gene_box); gr.pack(anchor="w", pady=(4,0))
        ttk.Button(gr, text="+ Add Gene", command=self.add_gene).pack(side=tk.LEFT, padx=4)
        ttk.Button(gr, text="− Remove Last", command=self.remove_gene).pack(side=tk.LEFT, padx=4)

        # --------- Notebook ----------
        nb = ttk.Notebook(self); nb.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        self.summary_tab = ttk.Frame(nb, padding=8); nb.add(self.summary_tab, text="Summary")
        self.summary_text = tk.Text(self.summary_tab, height=10, wrap="word"); self.summary_text.pack(fill=tk.BOTH, expand=True)

        self.mix_tab = ttk.Frame(nb, padding=8); nb.add(self.mix_tab, text="Master Mix Totals")
        self.mix_tree = self._make_tree(self.mix_tab, ["Gene","Chemistry","Placed reactions","Mix factor","Mix-equivalent reactions","2X master mix","RNAse-free H2O","10 µM probe","10 µM Forward","10 µM Reverse"])

        self.plate_tab = ttk.Frame(nb, padding=8); nb.add(self.plate_tab, text="Plate Layout (Canvas)")
        self.plate_view = PlateCanvas(self.plate_tab)

        # --------- Actions ----------
        actions = ttk.Frame(self, padding=(8,0)); actions.pack(fill=tk.X)
        ttk.Button(actions, text="Copy Plate TSV", command=self.copy_layout).pack(side=tk.LEFT, padx=4)
        ttk.Button(actions, text="Save Plate CSV", command=self.save_csv).pack(side=tk.LEFT, padx=4)
        ttk.Button(actions, text="Save Plate Excel", command=self.save_xlsx).pack(side=tk.LEFT, padx=4)
        ttk.Button(actions, text="Printable HTML", command=self.print_html).pack(side=tk.LEFT, padx=4)
        ttk.Button(actions, text="Help", command=lambda: messagebox.showinfo("Help", HELP)).pack(side=tk.RIGHT, padx=4)

        self._last_layout = []
        self._last_mix = []
        self._plates_dict = {}
        self._sample_group_map = OrderedDict()  # name -> group (if any)
        self._replicates = 2

    def add_gene(self):
        idx = len(self.gene_frames)
        gf = GeneConfigFrame(self.gene_box, idx)
        gf.pack(anchor="w")
        self.gene_frames.append(gf)

    def remove_gene(self):
        if not self.gene_frames: return
        gf = self.gene_frames.pop()
        gf.destroy()

    def _make_tree(self, parent, columns):
        tree = ttk.Treeview(parent, columns=columns, show="headings", height=18)
        for c in columns:
            tree.heading(c, text=c)
            width = 130
            if c in ("Gene","Chemistry","Mix factor"): width = 110
            if c == "Mix-equivalent reactions": width = 170
            tree.column(c, width=width, anchor=tk.CENTER)
        tree.pack(fill=tk.BOTH, expand=True)
        return tree

    # ------- helpers -------
    def _parse_pasted_samples(self):
        """Returns (ordered_names_list, name->group dict)."""
        txt = self.sample_text.get("1.0", "end").strip()
        names = []
        mapping = OrderedDict()
        if not txt:
            return names, mapping
        lines = [ln for ln in txt.splitlines() if ln.strip() and not ln.strip().startswith("#")]
        for ln in lines:
            parts = [p for p in re.split(r"[\t, ]+", ln.strip()) if p != ""]
            if not parts: continue
            name = parts[0]
            group = parts[1] if len(parts) > 1 else ""
            if name not in mapping:
                mapping[name] = group
                names.append(name)
        return names, mapping

    # ----------------- compute -----------------
    def compute(self):
        try:
            num_samples  = int(self.num_samples_var.get())
            num_stds     = int(self.num_standards_var.get())
            num_pos      = int(self.num_pos_var.get())
            reps         = int(self.num_reps_var.get())
            over_pct     = float(self.overage_pct_var.get())
            place_gapdh  = bool(self.place_gapdh_separate_var.get())
            inc_rtneg    = bool(self.include_rtneg_var.get())
            inc_rnaneg   = bool(self.include_rnaneg_var.get())
            self._replicates = reps

            if reps < 1:
                raise ValueError("Replicates must be ≥ 1.")
            labels_per_row = WELLS_PER_ROW // reps
            if labels_per_row < 1:
                raise ValueError(f"Replicates={reps} too large for 24 columns (need at least 1 label per row).")

            # samples: pasted list (preferred) or auto
            sample_names = []
            sample_group_map = OrderedDict()
            if self.use_pasted_samples_var.get():
                sample_names, sample_group_map = self._parse_pasted_samples()
                if not sample_names:
                    raise ValueError("You enabled 'Use pasted sample list' but nothing was parsed.")
                num_samples = len(sample_names)
            else:
                sample_names = [f"S{i}" for i in range(1, num_samples+1)]

            self._sample_group_map = sample_group_map  # keep for Excel template

            genes = [gf.get() for gf in self.gene_frames]
            if not genes: raise ValueError("At least one gene required.")
            # unique names
            seen = set()
            for g, _ in genes:
                if g in seen: raise ValueError(f"Duplicate gene: {g}")
                seen.add(g)

            # order genes; optionally force GAPDH to separate plates (start on new plate)
            gene_groups = []
            if place_gapdh:
                non_gapdh = [(g,c) for (g,c) in genes if g.lower() != "gapdh"]
                gapdh_only = [(g,c) for (g,c) in genes if g.lower() == "gapdh"]
                if non_gapdh: gene_groups.append(("Plate", non_gapdh))
                if gapdh_only: gene_groups.append(("Plate", gapdh_only))
            else:
                gene_groups.append(("Plate", genes))

            # Build layout plate by plate WITHOUT splitting a gene across plates
            all_layout = []
            all_mix = []
            plates_dict = defaultdict(list)
            plate_counter = 0  # global plate numbering

            for _, group_genes in gene_groups:
                row_idx = 0  # start at row 0 of a fresh plate
                for gene, chem_key in group_genes:
                    negatives = []
                    if inc_rtneg:  negatives.append("RT−")
                    if inc_rnaneg: negatives.append("RNA−")
                    blanks = ["Blank"]

                    samples   = sample_names[:]  # preserve user order
                    standards = [f"Std{n}" for n in range(1, num_stds+1)]
                    positives = [f"Pos{n}" for n in range(1, num_pos+1)] if num_pos > 0 else []

                    # *** ORDER CHANGED HERE ***
                    sections = [
                        ("Sample", samples),
                        ("Standard", standards),
                    ]
                    if positives:
                        sections.append(("Positive", positives))
                    sections.extend([
                        ("Negative", ["RT−"] if inc_rtneg else []),
                        ("Negative", ["RNA−"] if inc_rnaneg else []),
                        ("Blank", blanks),
                    ])
                    # Remove empties (e.g., if controls disabled)
                    sections = [(t, [x for x in xs if x]) for (t, xs) in sections]
                    sections = [(t, xs) for (t, xs) in sections if xs]

                    total_labels = sum(len(lbls) for _, lbls in sections)
                    rows_needed = ceil(total_labels / labels_per_row)
                    if rows_needed > len(PLATE_ROWS):
                        raise ValueError(
                            f"Gene '{gene}' requires {total_labels} label groups × {reps} replicates "
                            f"= {total_labels*reps} wells over {rows_needed} rows, which exceeds a 384 plate. "
                            f"Reduce samples/replicates or run this gene as a separate run."
                        )

                    # new plate if needed
                    if row_idx + rows_needed > len(PLATE_ROWS) or (plate_counter == 0 and row_idx == 0):
                        plate_counter += 1
                        current_plate = f"Plate {plate_counter}"
                        row_idx = 0
                    else:
                        current_plate = f"Plate {plate_counter}"

                    chem = CHEMISTRY[chem_key]
                    col_idx = 0
                    placed_for_gene = 0

                    def place_block(label_type, labels):
                        nonlocal row_idx, col_idx, placed_for_gene
                        for lab in labels:
                            if col_idx + reps > WELLS_PER_ROW:
                                col_idx = 0
                                row_idx += 1
                            if row_idx >= len(PLATE_ROWS):
                                raise RuntimeError("Unexpected overflow after pre-check.")
                            for r in range(reps):
                                well = f"{PLATE_ROWS[row_idx]}{PLATE_COLS[col_idx + r]}"
                                record = {
                                    "Plate": current_plate, "Well": well, "Gene": gene,
                                    "Type": label_type, "Label": lab, "Replicate": r+1
                                }
                                # attach Group for samples (if pasted map provided)
                                if label_type == "Sample":
                                    record["Group"] = sample_group_map.get(lab, "")
                                all_layout.append(record)
                                plates_dict[current_plate].append(record)
                                placed_for_gene += 1
                            col_idx += reps
                            if col_idx >= WELLS_PER_ROW:
                                col_idx = 0
                                row_idx += 1

                    for label_type, labels in sections:
                        if labels:
                            place_block(label_type, labels)

                    # end gene: move to next row boundary
                    if col_idx != 0:
                        col_idx = 0
                        row_idx += 1
                    if row_idx > len(PLATE_ROWS):
                        raise RuntimeError("Post-gene row index overflow.")

                    # MIX totals
                    n_rxn = placed_for_gene
                    factor = 1.0 + (over_pct/100.0)
                    mix_equiv_rxn = n_rxn * factor
                    per = chem.per_sample
                    all_mix.append({
                        "Gene": gene,
                        "Chemistry": chem.name,
                        "Placed reactions": n_rxn,
                        "Mix factor": f"{factor:.2f}×",
                        "Mix-equivalent reactions": f"{mix_equiv_rxn:.1f}",
                        "2X master mix":  per["2X master mix"]  * mix_equiv_rxn,
                        "RNAse-free H2O": per["RNAse-free H2O"] * mix_equiv_rxn,
                        "10 µM probe":    per["10 µM probe"]    * mix_equiv_rxn,
                        "10 µM Forward":  per["10 µM Forward"]  * mix_equiv_rxn,
                        "10 µM Reverse":  per["10 µM Reverse"]  * mix_equiv_rxn,
                    })

            # --- Fill UI ---
            for i in self.mix_tree.get_children(): self.mix_tree.delete(i)
            for row in all_mix:
                self.mix_tree.insert("", "end", values=[
                    row["Gene"], row["Chemistry"], row["Placed reactions"], row["Mix factor"], row["Mix-equivalent reactions"],
                    f'{row["2X master mix"]:.1f}', f'{row["RNAse-free H2O"]:.1f}',
                    f'{row["10 µM probe"]:.1f}', f'{row["10 µM Forward"]:.1f}', f'{row["10 µM Reverse"]:.1f}',
                ])

            used_by_plate = {p: len(rows) for p, rows in plates_dict.items()}
            lines = []
            if not used_by_plate:
                lines.append("No wells placed.")
            else:
                for p in sorted(plates_dict.keys(), key=lambda x: int(x.split()[1])):
                    n = used_by_plate[p]
                    lines.append(f"{p}: {n} used / 384; empty {384-n}.")
            self.summary_text.delete("1.0","end")
            self.summary_text.insert("1.0", "\n".join(lines) + "\n\n" + HELP)

            genes_all = sorted({row["Gene"] for row in all_layout})
            palette = ["#8dd3c7","#ffffb3","#bebada","#fb8072","#80b1d3","#fdb462",
                       "#b3de69","#fccde5","#d9d9d9","#bc80bd","#ccebc5","#ffed6f"]
            colors = {g: palette[i % len(palette)] for i, g in enumerate(genes_all)}
            self.plate_view.set_data(plates_dict, colors)

            self._last_layout = all_layout
            self._last_mix = all_mix
            self._plates_dict = plates_dict

        except Exception as e:
            messagebox.showerror("Error", str(e))

    # ---------------- exports ----------------
    def copy_layout(self):
        if not self._last_layout:
            messagebox.showinfo("Info", "No layout yet. Click Compute.")
            return
        headers = ["Plate","Well","Gene","Type","Label","Replicate","Group"]
        lines = ["\t".join(headers)]
        for r in self._last_layout:
            lines.append("\t".join(str(r.get(h, "")) for h in headers))
        tsv = "\n".join(lines)
        self.clipboard_clear(); self.clipboard_append(tsv); self.update()
        messagebox.showinfo("Copied", "Plate layout copied to clipboard (TSV).")

    def save_csv(self):
        if not self._last_layout:
            messagebox.showinfo("Info", "No layout yet. Click Compute.")
            return
        path = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV","*.csv")])
        if not path: return
        headers = ["Plate","Well","Gene","Type","Label","Replicate","Group"]
        try:
            with open(path, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f); w.writerow(headers)
                for r in self._last_layout:
                    w.writerow([r.get(h, "") for h in headers])
            messagebox.showinfo("Saved", f"Saved CSV:\n{path}")
        except Exception as e:
            messagebox.showerror("Error", str(e))

    def save_xlsx(self):
        if not self._last_layout:
            messagebox.showinfo("Info", "No layout yet. Click Compute.")
            return
        if not HAVE_PANDAS:
            messagebox.showwarning("Missing dependency", "Install pandas + xlsxwriter to export Excel.")
            return
        path = filedialog.asksaveasfilename(defaultextension=".xlsx", filetypes=[("Excel","*.xlsx")])
        if not path: return
        try:
            df_plate = pd.DataFrame(self._last_layout)
            df_mix = pd.DataFrame(self._last_mix)

            # Build Template sheet rows: one row per (Gene, Type, Label) in appearance order
            reps = self._replicates
            cols = ["Gene","Type","Label","Group"] + [f"r{i}" for i in range(1, reps+1)] + ["Avg"]
            rows = []
            seen_keys = set()
            for rec in self._last_layout:
                key = (rec["Gene"], rec["Type"], rec["Label"])
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                rows.append({
                    "Gene": rec["Gene"],
                    "Type": rec["Type"],
                    "Label": rec["Label"],
                    "Group": (rec.get("Group","") if rec["Type"]=="Sample" else "")
                })
            df_template = pd.DataFrame(rows, columns=["Gene","Type","Label","Group"])
            # add empty replicate cols + Avg placeholder (will overwrite with formulas)
            for i in range(1, reps+1):
                df_template[f"r{i}"] = ""
            df_template["Avg"] = ""

            with pd.ExcelWriter(path, engine="xlsxwriter") as writer:
                # Plate + MM
                df_plate.to_excel(writer, sheet_name="Plate", index=False)
                df_mix.to_excel(writer, sheet_name="MasterMix", index=False)

                # Template
                df_template.to_excel(writer, sheet_name="Template", index=False)
                wb = writer.book
                for name, df in (("Plate", df_plate), ("MasterMix", df_mix), ("Template", df_template)):
                    ws = writer.sheets[name]
                    header = wb.add_format({"bold": True, "bg_color": "#E6F3FF", "border": 1})
                    cell = wb.add_format({"border": 1})
                    ws.set_row(0, None, header)
                    for col, col_name in enumerate(df.columns):
                        width = 16
                        if col_name in ("Plate","Well","Gene","Type","Label","Group"): width = 18
                        ws.set_column(col, col, width, cell)

                # Insert AVERAGE formulas in Template! (beside replicates)
                wsT = writer.sheets["Template"]
                start_row = 1  # 0-based (row 1 is header)
                nrows = len(df_template)
                # Columns: Gene(0) Type(1) Label(2) Group(3) r1(4) ... rN(3+reps) Avg(4+reps)
                first_r_col = 4
                last_r_col = 3 + reps
                avg_col = 4 + reps
                # Helper to convert col index -> Excel letter(s)
                def xl_col(col_idx):
                    letters = ""
                    while col_idx >= 0:
                        letters = chr(col_idx % 26 + ord('A')) + letters
                        col_idx = col_idx // 26 - 1
                    return letters
                for i in range(nrows):
                    excel_row = i + 2  # Excel is 1-based and header is row 1
                    c1 = xl_col(first_r_col) + str(excel_row)
                    c2 = xl_col(last_r_col)  + str(excel_row)
                    formula = f"=AVERAGE({c1}:{c2})"
                    wsT.write_formula(i+1, avg_col, formula)

            messagebox.showinfo("Saved", f"Saved Excel with Template & Avg formulas:\n{path}")
        except Exception as e:
            messagebox.showerror("Error", str(e))

    def print_html(self):
        if not self._plates_dict:
            messagebox.showinfo("Info", "No layout yet. Click Compute.")
            return

        genes = sorted({r["Gene"] for rows in self._plates_dict.values() for r in rows})
        palette = ["#8dd3c7","#ffffb3","#bebada","#fb8072","#80b1d3","#fdb462",
                   "#b3de69","#fccde5","#d9d9d9","#bc80bd","#ccebc5","#ffed6f"]
        colors = {g: palette[i % len(palette)] for i, g in enumerate(genes)}

        def plate_table(pname, rows):
            m = {(r["Well"][0], int(r["Well"][1:])): r for r in rows}
            rows_html = [f"<h2>{pname}</h2>", "<table class='plate'>"]
            rows_html.append("<tr><th></th>" + "".join(f"<th>{c}</th>" for c in PLATE_COLS) + "</tr>")
            for rl in PLATE_ROWS:
                tds = [f"<th>{rl}</th>"]
                for c in PLATE_COLS:
                    r = m.get((rl, c))
                    if r:
                        colr = colors[r['Gene']]
                        label = f"{r['Gene']}<br><small>{r['Type']}: {r['Label']}, r{r['Replicate']}</small>"
                        tds.append(f"<td style='background:{colr}'>{label}</td>")
                    else:
                        tds.append("<td class='empty'></td>")
                rows_html.append("<tr>" + "".join(tds) + "</tr>")
            rows_html.append("</table>")
            return "\n".join(rows_html)

        legend = "<div class='legend'><h3>Legend</h3>" + "".join(
            f"<span class='sw' style='background:{colors[g]}'></span> {g}&nbsp;&nbsp;" for g in genes
        ) + "</div>"

        html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>qPCR Plate Layout</title>
<style>
body {{ font-family: Arial, sans-serif; margin: 16px; }}
h1 {{ font-size: 20px; margin: 6px 0 12px; }}
h2 {{ font-size: 16px; margin: 12px 0 4px; }}
.plate {{ border-collapse: collapse; margin-bottom: 16px; }}
.plate th, .plate td {{ border: 1px solid #888; padding: 4px; font-size: 11px; text-align: center; }}
.plate th {{ background: #f0f0f0; }}
.plate td.empty {{ background: #fff; }}
.legend .sw {{ display:inline-block; width:14px; height:14px; border:1px solid #666; margin-right:4px; vertical-align:middle; }}
@media print {{ @page {{ size: A4 landscape; margin: 8mm; }} }}
</style></head>
<body onload="window.print()">
<h1>qPCR Plate Layout (384-well)</h1>
{legend}
{"".join(plate_table(p, self._plates_dict[p]) for p in sorted(self._plates_dict, key=lambda x: int(x.split()[1])))}
</body></html>"""
        try:
            fd, path = tempfile.mkstemp(suffix=".html", prefix="qpcr_plate_")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(html)
            webbrowser.open_new_tab("file://" + path)
        except Exception as e:
            messagebox.showerror("Error", f"Could not open printable view:\n{e}")

if __name__ == "__main__":
    App().mainloop()
