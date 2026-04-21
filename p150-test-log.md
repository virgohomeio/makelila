# P150 Test Log — Defect Assessment & Rework/Scrap Disposition

**Date:** 2026-04-20  
**Source:** Kishore Yogaraj's Notion workspace (P150 Machine Counter, Master Issue Log, Machine Return Diagnostic Doc, BOM For P150 Replacement Parts, P150 Broken Chamber analysis)  
**Batch:** P150 (138 units total, v3.6, manufactured by MBV)

---

## Summary

| Metric | Count |
|--------|-------|
| Total P150 units | 138 |
| Defective (flagged) | 50 |
| Delivered | 49 |
| Returned | 10 |
| Unchecked | 21 |
| **Reworkable (estimated)** | **30–35** |
| **Scrap (estimated)** | **5–8** |
| **Needs further diagnosis** | **10–12** |

---

## Defective Units Inventory (from P150 Machine Counter)

| # | Serial Number | Colour | Notes | Known Issue(s) |
|---|--------------|--------|-------|----------------|
| 1 | LL01-00000000006 | White | — | Undiagnosed |
| 2 | LL01-00000000008 | White | — | Undiagnosed |
| 3 | LL01-00000000009 | White | — | Undiagnosed |
| 4 | LL01-00000000010 | White | — | Tight Left Latch |
| 5 | LL01-00000000018 | White | — | Undiagnosed |
| 6 | LL01-00000000024 | White | Testing | Filter Crack |
| 7 | LL01-00000000027 | White | — | Board Interference / Chamber Crack |
| 8 | LL01-00000000028 | White | Testing | Crusher Not Turning / Body Cracks |
| 9 | LL01-00000000030 | White | — | LED Does Not Display |
| 10 | LL01-00000000034 | White | — | Undiagnosed |
| 11 | LL01-00000000035 | White | — | Liquid Thinner Spill |
| 12 | LL01-00000000038 | White | — | Tight Left Latch |
| 13 | LL01-00000000039 | White | — | Undiagnosed |
| 14 | LL01-00000000046 | White | Huayi for testing | Undiagnosed |
| 15 | LL01-00000000047 | White | — | Left Pad Heater Failure |
| 16 | LL01-00000000048 | White | — | Right Pad Heater Failure |
| 17 | LL01-00000000051 | White | — | Missing Gear Box |
| 18 | LL01-00000000053 | White | — | Undiagnosed |
| 19 | LL01-00000000066 | White | Production Testing | Undiagnosed |
| 20 | LL01-00000000072 | Black | — | Missing Front Gasket |
| 21 | LL01-00000000086 | White | — | Undiagnosed |
| 22 | LL01-00000000089 | White | — | Cracks on Machine Body |
| 23 | LL01-00000000090 | White | Huayi Testing / Onboarding demos | Undiagnosed |
| 24 | LL01-00000000093 | White | — | LED Does Not Display |
| 25 | LL01-00000000094 | White | — | Undiagnosed |
| 26 | LL01-00000000095 | White | — | Rear Lid Notch Missing |
| 27 | LL01-00000000096 | Black | — | Internal PTC Failure |
| 28 | LL01-00000000098 | Black | — | Undiagnosed |
| 29 | LL01-00000000102 | White | — | Undiagnosed |
| 30 | LL01-00000000103 | White | Marketing, In Office | Undiagnosed |
| 31 | LL01-00000000106 | Black | Testing | AC Main Power Test Failure |
| 32 | LL01-00000000111 | White | — | Undiagnosed |
| 33 | LL01-00000000113 | White | Testing | Undiagnosed |
| 34 | LL01-00000000118 | White | — | Left Motor Failure |
| 35 | LL01-00000000123 | White | — | Tight Left Latch / Liquid Thinner Spill |
| 36 | LL01-00000000128 | Black | Testing | Undiagnosed |
| 37 | LL01-00000000131 | Black | Testing | Undiagnosed |
| 38 | LL01-00000000134 | Black | — | Undiagnosed |
| 39 | LL01-00000000139 | Unknown | In storage, colour unclear | Tight Left Latch |
| 40 | LL01-00000000148 | White | — | Undiagnosed |
| 41 | LL01-00000000149 | Black | — | Rear Lid Notch Missing |
| 42 | LL01-00000000158 | White | — | Gasket Missing |
| 43 | LL01-00000000159 | White | Testing | Undiagnosed |
| 44 | LL01-00000000160 | White | — | Undiagnosed |
| 45 | LL01-00000000162 | Black | — | Liquid Thinner Spill |

*Note: 5 additional defective serials may exist in unpaginated data. The 50-unit count from P150 Inventory Count is the authoritative total.*

---

## Master Issue Log — Full Catalog

### Critical / SCRAP-Likely Issues

These issues have **no known fix**, require unavailable parts, or render the machine non-functional:

| Issue | Type | Difficulty | Impact | Machines Affected | Disposition |
|-------|------|-----------|--------|-------------------|-------------|
| Left Pad Heater Failure | Electrical | High | High | LL01-047 | **SCRAP** — no spares, full disassembly required |
| Right Pad Heater Failure | Electrical | High | High | LL01-048 | **SCRAP** — no spares, full disassembly required |
| Internal PTC Failure | Electrical | High | High | LL01-096 | **SCRAP** — no spares, P50 PTC incompatible |
| Left Motor Failure | Electrical | High | High | LL01-118 | **SCRAP** — no spares available in-house |
| AC Main Power Test Failure | Electrical | Unknown | High | LL01-106 | **SCRAP** — relay failure, no solution identified |

### Reworkable Issues — Parts Swap (Low Difficulty)

These can be fixed by harvesting parts from scrapped units or using available materials:

| Issue | Type | Difficulty | Impact | Machines Affected | Fix |
|-------|------|-----------|--------|-------------------|-----|
| Missing Gear Box | Mechanical | Low | High | LL01-051 | Harvest gear box from a scrapped unit |
| Missing Front Gasket | Mechanical | Low | Low | LL01-072 | Order replacement or harvest from scrap |
| Rear Lid Notch Missing | Mechanical | Low | High | LL01-095, LL01-149 | Harvest notch from scrapped unit |
| Gasket Missing (body rim) | Mechanical | Low | Medium | LL01-158 | Glue gasket; material available |
| Filter Crack | Mechanical | Low | Low | LL01-024 | Swap filter from scrapped unit or tape |
| Label Sticker Not Removed | Aesthetic | Low | Low | LL01-056 | Remove sticker |
| Exterior Surface Contamination | Aesthetic | Low | Low | (various) | Clean with water/paper towel |
| Compost Chamber Paint Peeled | Aesthetic | Low | Low | (various) | Wipe off paint chips |
| Front Cover Film Damaged | Aesthetic | Low | Low | (various) | Replace film from scrapped unit |
| Outer Packaging Misaligned | Aesthetic | Low | Low | (various) | Rotate foam 180° |
| Holes Missing (bottom legs) | Mechanical | Low | Medium | (various) | Poke drainage holes |
| Main Filter Module Not Installed | Mechanical | Low | High | (various) | Insert filter from defective unit |
| PCBA Cable Routing | Electrical | Low | Low | (various) | Accept defect |

### Reworkable Issues — Requires Effort (Medium Difficulty)

| Issue | Type | Difficulty | Impact | Machines Affected | Fix |
|-------|------|-----------|--------|-------------------|-----|
| Board Interference (random errors) | Electrical | Medium | High | LL01-027 | Software fix: remove BME sensor readings, use hardcoded algorithm |
| Compost Chamber Corner Broke Off | Mechanical | Medium | Low | (various) | Sand off broken corner |
| Chamber Motor Shafts Inserted Wrong | Mechanical | Medium | High | (various) | Disassemble and refit shaft |
| Startup Error (mixing not starting) | Software | Medium | High | (various) | Software fix: add delay; reflash firmware |
| Grinding/Mixing Not Working | Software | Medium | High | Inconsistent | Open lid → restart → close lid; repeatable fix |
| Side Latch Falls Off | Mechanical | Medium | High | (various) | Re-glue side latch |

### Conditional Rework — Needs Assessment

| Issue | Type | Difficulty | Impact | Machines Affected | Notes |
|-------|------|-----------|--------|-------------------|-------|
| Tight Left Latch | Mechanical | High | High | LL01-010, 038, 139, 123 | Metal blade deformed by manufacturer. No in-house fix. Could sell to tolerant customers |
| LED Does Not Display | Electrical | High | High | LL01-030, 093 | Requires full disassembly + LED replacement. No material in-house currently |
| Liquid Thinner Spill | Aesthetic | Unknown | Medium | LL01-035, 162, 123 | Try TSP degreaser. Non-functional impact but customer-facing |
| Cracks on Machine Body | Mechanical | Unknown | Medium | LL01-028, 089 | Moisture-induced. Longevity concern. Root cause: PP+10%GF (weaker than P50's PP+30%GF) |
| Crusher Not Turning | Unknown | Unknown | High | LL01-028 | Crusher being removed in future batches — may be acceptable |
| Chamber Crack (explosion) | Software | High | High | LL01-027 | Algorithm fix needed (mixing ratio). Reinforce with AB glue. Chamber material PP+10%GF is weaker |
| Main Filter Bracket Misaligned | Mechanical | High | Medium | 26% of units affected | Manufacturer defect. No in-house solution documented |
| Rust on Screws | Mechanical | High | Medium | (various) | Accept defect or use stainless steel replacements |
| Insulating Material Deteriorating | Mechanical | Unknown | Medium | (field units) | Needs investigation. Single occurrence |
| Top Lid Micro Switch Distance | Mechanical | Unknown | Medium | (various) | Single occurrence, needs further investigation |
| Chamber Motors Did Not Start | Unknown | High | High | (field) | Software fix needed |

---

## Root Cause Analysis: P150 vs P50 Chamber Failures

From Kishore's "P150 Broken Chamber" investigation:

| Factor | P50 | P150 | Why It Matters |
|--------|-----|------|---------------|
| Glass Fiber Content | PP + 30% GF | PP + 10% GF | Less strength, easier to break |
| Mixer Tightness | Smoother | Very tight | Extra stress on chamber body |
| Painting Method | Standard | Different method | Material property changed during painting |

**Conclusion:** P150 chambers are structurally weaker than P50. The combination of lower glass fiber reinforcement, tighter mixer shafts, and a different painting process makes P150 chambers prone to cracking under stress. The proposed fix is to add fillets to reduce stress concentration.

---

## BOM — Available Replacement Parts

| Part Name | Notes |
|-----------|-------|
| Left Chamber Motor | For motor replacement rework |
| Gear Box | For LL01-051 fix |
| Right Pad Heater | Limited availability |
| Internal PTC | For reference only — P50 PTC incompatible |
| PCBA | Board replacement |
| Front LED | For LED display fix |
| Rear Lid Notch | For LL01-095, 149 fix |
| Main Gasket (Outer Shell) | For gasket issues |
| BME 688 Left/Right | Sensor reference |

---

## Disposition Recommendation

### SCRAP (5 units) — Use as parts donors

| Serial | Issue | Reason |
|--------|-------|--------|
| LL01-00000000047 | Left Pad Heater Failure | No replacement parts, full disassembly needed |
| LL01-00000000048 | Right Pad Heater Failure | No replacement parts, full disassembly needed |
| LL01-00000000096 | Internal PTC Failure | No compatible spares exist |
| LL01-00000000118 | Left Motor Failure | No replacement parts available |
| LL01-00000000106 | AC Main Power Failure | Relay failure, undiagnosed root cause |

*These 5 units should be designated as parts donors. Their working components (gaskets, filters, rear lid notches, gear boxes, front covers, chambers) can be harvested for rework of other units.*

### REWORK — HIGH CONFIDENCE (15–18 units)

Units with Low-difficulty mechanical/aesthetic issues that can be fixed with available parts or parts from scrapped units:

- LL01-051 (Missing Gear Box → harvest from scrap)
- LL01-072 (Missing Front Gasket → replace)
- LL01-095, LL01-149 (Rear Lid Notch → harvest from scrap)
- LL01-158 (Gasket Missing → glue available)
- LL01-024 (Filter Crack → swap from scrap)
- LL01-035, LL01-162, LL01-123 (Liquid Thinner Spill → attempt TSP cleaning)
- LL01-010, LL01-038, LL01-139 (Tight Left Latch → sell to tolerant customers)
- LL01-028 (Crusher Not Turning → crusher being deprecated)
- All units with software-only issues once firmware is updated

### REWORK — CONDITIONAL (10–12 units)

Requires software fix deployment or specific parts procurement:

- LL01-027 (Board Interference → software fix available, chamber may need AB glue reinforcement)
- LL01-089 (Body Cracks → assess severity, may still be shippable)
- LL01-030, LL01-093 (LED failure → reworkable IF LED parts procured)
- Units noted "Testing" with no documented issue → likely pass after re-test

### NEEDS DIAGNOSIS (10–15 units)

Units flagged defective with no logged issue in the Master Issue Log. These need Kishore's team to run the PC application test and physical inspection:

LL01-006, 008, 009, 018, 034, 039, 053, 066, 086, 094, 098, 102, 103, 111, 113, 128, 131, 134, 148, 159, 160

---

## Recommended Next Steps

1. **Run PC application test** on all "Undiagnosed" units to identify electrical failures vs. cosmetic-only issues
2. **Deploy firmware update** addressing BME sensor interference and startup error — this could immediately recover 3–5 units
3. **Designate 5 scrap units** as parts donors and begin harvesting components
4. **Prioritize rework** of Low-difficulty units (est. 2–3 hours each) to recover inventory for fulfillment
5. **Order replacement LEDs** if budget allows — would recover 2 additional units
6. **Communicate with manufacturer (MBV)** about recurring issues: tight left latch (8.7%), filter bracket misalignment (26%), low GF content causing chamber weakness
7. **Update P150 Machine Counter** in Notion with disposition status for each unit after rework assessment is complete

---

## Data Sources

- Kishore Yogaraj Notion workspace → P150 Machine Counter (collection://2b7ffbba-4c38-8074-883a-000b349b56bb)
- Kishore Yogaraj Notion workspace → Master Issue Log (collection://27fffbba-4c38-80b2-8271-000b4e49eb65)
- Machine Return Diagnostic Doc (collection://2beffbba-4c38-806d-a4a1-000b026d00b6)
- BOM For P150 Replacement Parts (collection://2d3ffbba-4c38-80a1-bfad-000be4f8faa1)
- P150 Broken Chamber root cause analysis page
