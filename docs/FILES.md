# Office documents and archives

The `files` module runs nine registered local actions. Generated artifacts are returned as Discord attachments. No Office application or extra API key is required.

| Action             | Implemented behavior                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file.csv`         | UTF-8 CSV with BOM, quoted cells, multiline text, and formula-injection escaping.                                                                                |
| `file.xlsx`        | Real macro-free XLSX packages, up to five sheets and 50,000 typed literal cells, bold optional header, frozen row and filter. Formula-like strings stay strings. |
| `file.docx`        | Real DOCX with title, headings, paragraphs, line breaks, and bullet/numbered lists.                                                                              |
| `file.pptx`        | Real 16:9 PPTX with title/bullet slides, slide numbers, theme, layouts, and embedded speaker notes.                                                              |
| `file.extract`     | Text from supported DOCX, PPTX, XLSX, CSV, TXT, MD, LOG and JSON attachments. XLSX includes typed row data; PowerPoint text follows declared slide order.        |
| `file.convert`     | CSV/XLSX table conversion, supported document content to TXT/DOCX. CSV exports the first worksheet and says so. Text conversions disclose truncation.            |
| `file.zip`         | Pack 1–20 supplied text files into a ZIP.                                                                                                                        |
| `file.zip-info`    | Read bounded central-directory metadata.                                                                                                                         |
| `file.zip-extract` | Validate and return one exact named entry as an attachment. Entries are never extracted to the host filesystem.                                                  |

Downloads accept HTTPS Discord attachment URLs only. All Office and ZIP processing runs in at most two worker threads, each with a 256 MB V8 old-generation budget and a 20-second deadline. Input and output artifacts are capped at 8 MB. ZIP limits are 256 entries, 8 MB per entry, 32 MB total declared and actual output, and a maximum 200:1 compression ratio. CRCs, sizes, unique safe paths, encryption flags, and supported compression methods are checked. ZIP64, split archives, encrypted archives, unsafe/reserved names, and unsupported ZIP layouts are rejected. Highly repetitive generated packages fall back to stored ZIP entries so the bot can read its own results within the ratio limit.

OpenXML inputs reject DTD/entity declarations, XML deeper than 64 levels, macro-enabled packages, ActiveX, macros, and embedded object packages. External worksheet/slide relationships are rejected. Formulas are never executed; supported XLSX formulas return their cached primitive values when present. Extraction supports conventional `w:`, `a:`, and `p:` Office XML prefixes, up to ten input sheets, 2,000 rows per sheet, 50 columns, 50,000 cells, and 100 slides. Extracted text is capped at 30,000 characters. Generated PPTX slides use a simple title/bullet layout; conversion does not preserve arbitrary source layout, drawings, charts, animation, or formatting. PowerPoint extraction returns slide text, excluding notes.

Tests exercise real generated packages, worker results, conversions, malformed CSV, ZIP tampering and decompression limits, XML hazards, sparse workbook rows and reordered slides. An optional independent-reader test uses `openpyxl`, `python-docx`, and `python-pptx` when those Python libraries are available. They are validation tools, not runtime bot dependencies.
