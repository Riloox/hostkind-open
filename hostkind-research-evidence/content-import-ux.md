# Minecraft content import design

- Screen job: browse Modrinth or inspect and install an existing Minecraft content file.
- Primary action: search while browsing; choose a file within the importer, then install the inspected result.
- Hierarchy: browse source and separate import entry, source choice, file requirements, inspection, installation.
- Controls: existing Radix dialog and tabs; CurseForge ZIP and FTB installer are distinct paths. FTB IDs have visible labels, numeric validation and an explicit version selector. Official preparation is disclosed as advanced because it still requires an installer upload.
- Visual language: existing dark surfaces, orange action color, borders, typography and spacing tokens. No new decorative badges or card grid.
- States: disabled controls explain prerequisites; inspection and apply errors remain visible; queued/running operations prevent duplicate submissions; successful installs disable repeat apply.
- Responsive: two form columns at wider widths, one on narrow screens; bounded scrolling dialog; native focus trapping and return to trigger.
- Evidence: UIZZE Payment attachment https://uizze.com/screens/699b425c0025545e1e9c supports explaining upload before review; Bill Review https://uizze.com/screens/699b425a0020d01684c3 supports a distinct review action; Shopee Shop Information https://uizze.com/screens/699b1bf10008d5f4fa84 supports labeled staged inputs. Only text/structural reference evidence was available; no branding or exact layouts copied. User screenshots and repository components determine the visual language.
- Forbidden: ambiguous Apply/Prepare actions competing with search, unlabeled IDs, multiple providers in one dense row, unsupported verified claims.
- Acceptance: source-specific controls, required numeric FTB details, preserved backend request contracts, no dialog overflow at 390/768/1440px, Escape closes and restores focus.
