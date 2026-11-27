# Technical follow-ups

- **Session imports.** SecureCRT session imports read connection settings. A sanitized button-bar export and its expected snippet mapping would help extend the importer to saved buttons.
- **On-device verification.** Real Junos commit-history samples can help validate how Hopline identifies pending and confirmed commits across releases. Include both the command and a sanitized result.
- **Privacy fixtures.** A partial terminal selection can omit the header identifying a description column. Include the complete command output and the partial selection when reporting an example. Review exported session logs locally before sharing them.
- **Electron tests.** The session-host timing checks are sensitive to CPU starvation. Run with an isolated profile and a quiet machine. Record the affected OS, test and trace when a retry changes the result.

[Project direction](ROADMAP.md)
