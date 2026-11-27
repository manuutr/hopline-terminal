# Terminal workflows in 0.10

This release focuses on work an engineer can complete inside a local network terminal. The four products below informed the interaction choices. The comparison covers the features adapted for this release.

| Product | Workflow in the reference product | How to use it in Hopline |
| --- | --- | --- |
| [MobaXterm](https://mobaxterm.mobatek.net/download-home-edition.html) | SSH browser can follow the terminal folder. | Turn on **Follow folder** in Files when a shell reports its working directory. Manual navigation takes control back. The existing SFTP channel provides the listing. |
| [PuTTY](https://the.earth.li/~sgtatham/putty/latest/htmldoc/Chapter3.html) | Copy the terminal contents, including scrollback. | **Edit › Copy all terminal output** joins wrapped lines and masks recognised secrets before copying. |
| [SecureCRT](https://www.vandyke.com/products/securecrt/features.html) | Scratchpad for notes during a terminal session. | Open **View › Open scratchpad…**, collect lines across tabs, then save to a text file. The draft belongs to the window and closes with it. |
| [Royal TS](https://docs.royalapps.com/r2023/royalts/user-interface/dashboards.html) | Filter connections by text or connection state in a dashboard. | Open **Session overview**, filter the list and select the exact tab or saved session to open. Duplicate tabs appear separately. |

The terminal palette browser uses the same device transcript for all twenty choices so operators can compare prompts, link states and errors. The session overview shows folder names where space permits and marks the active connection with an accent rule. Both use the existing keyboard controls. Motion is brief and scoped to the changing panel. The system’s reduced-motion preference disables it. [ThinkUI component examples](https://thinkui.xyz/examples) · [Uizze interface guide](https://uizze.com/codex-ui-design).

Sessions, notes and file navigation use the existing local application. Remote desktop clients, an X server and a shared database of engineers’ activity sit outside the scope of this terminal release.
