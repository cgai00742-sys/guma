# Sample sliced files

Three files for trying slicer import without having to slice something
first. Drop one onto any project's build sheet (Project → Build sheet →
**Import a sliced file**).

They are deliberately tiny: the importer reads the header and footer
comments and never the toolpath, so the movement commands are omitted. A
real file off a real machine behaves identically. `src/lib/samples.test.ts`
parses all three on every test run, so a sample that stops matching the
importer fails the build rather than quietly misleading someone.

| File | What it exercises | What you should see |
|---|---|---|
| `reef-buoy_prusa.gcode` | The ordinary case. PrusaSlicer, objects labelled. | Two parts — **Hull shell ×2**, **Cap ×1** · 86.5 g PETG · ~2h 3m · machine reads **Prusa XL** |
| `H2S_Sakman ama_sliced.gcode.3mf` | Bambu / Orca. A real zip, deflate-compressed, read through `slice_info.config`. | Two parts — **Sakman ama ×2**, **Sakman iako ×1** · 142.8 g PETG · ~2h 33m · machine reads **Bambu Lab H2S** (decoded from the code `O1S`) |
| `calibration_no-labels.gcode` | The awkward case: "Label objects" was off when slicing. | One part named from the filename, plus a note saying which slicer setting to turn on |

Things worth checking while you are in there:

- **The machine and material dropdowns.** They should pre-select your Prusa
  XL and a PETG spool if you have them, and say *not matched* if you do not.
  Either is fine; neither blocks the import.
- **Nothing is recorded as printed.** After importing, "What it actually
  took" must still read zero. The estimate is not an actual until you log a
  run by hand.
- **Import the same file twice.** The parts should not duplicate — the
  second import attaches its estimate to the parts already there. That is
  the fixed-file-for-reprint case.
- **`.bgcode`.** If you have binary G-code on in PrusaSlicer, try one. You
  should get a sentence naming the exact setting to turn off, not a shrug.
