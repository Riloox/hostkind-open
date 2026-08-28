# tModLoader mod import UX

Status: implementation contract

## Evidence

- Nielsen Norman Group's confirmation-dialog guidance says a confirmation must restate the requested action, show specific consequences, and use action labels instead of vague Yes/No/Confirm buttons: https://www.nngroup.com/articles/confirmation-dialog/
- Material Design 3 recommends a clear headline, supporting text, no more than two dialog actions, a confirming action closest to the edge, and disabling confirmation only when a required choice is missing: https://m3.material.io/components/dialogs/guidelines
- Steam Workshop exposes missing dependencies, load order, and collection/mod-list concepts as visible parts of mod management rather than hiding them behind a one-click install: https://steamcommunity.com/workshop
- tModLoader's dedicated-server documentation identifies `enabled.json` and `install.txt` as part of the server mod workflow; this makes restart/apply timing and the installed-vs-enabled distinction important to explain: https://docs.tmodloader.net/docs/stable/md__github_workspace_src_t_mod_loader__terraria_release_extras__dedicated_server_utils__r_e_a_d_m_e.html

## Design contract

| Field | Decision |
| --- | --- |
| Screen job | Let an operator verify exactly which tModLoader files will change before import. |
| Primary user and action | A hobbyist server operator reviews the plan, explicitly approves replacement when needed, then imports. |
| Content hierarchy | 1) what changes now, 2) which mods are added/replaced, 3) why the operation is safe and when it takes effect, 4) source/version detail. |
| Navigation and controls | Keep one dismiss action and one specific commit action. Use a replacement acknowledgement only when an existing mod will be overwritten. |
| Visual language | Preserve Hostkind's ember workbench: hard borders, restrained signals, compact data rows, no decorative gradients or new component family. |
| Required states | Added-only, replacement, mixed multi-mod plan, blocked modpack plan, busy/applying, and translated copy. |
| Responsive behavior | The plan remains readable at narrow widths; metadata wraps and action controls stay reachable without horizontal scrolling. |
| Evidence used | NN/g confirmation specificity; Material dialog hierarchy/actions; Steam Workshop dependency visibility; tModLoader server workflow. |
| Forbidden defaults | No raw `ADD`, no generic `Confirm`, no standalone unexplained internal-name field, no hidden replacement side effect. |
| Acceptance criteria | The dialog names the change, shows counts and per-mod versions, states that nothing changed yet, explains snapshot/restart timing, uses an explicit replacement acknowledgement, and keeps all actions keyboard/focus accessible. |
