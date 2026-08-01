# Documentation screenshots

`auto/` contains the minimal generated screenshot set used by the Desktop App
Guide. Run `pnpm screenshots` after a core route, product label, or shared
chrome change. The harness builds Desktop, launches an isolated profile with
real **Open Cowork** branding and public feature defaults, and captures at
1600×1000 in dark mode.

The owned journey manifest is
`apps/desktop/tests/documentation-screenshot-journeys.mjs`. The docs gate fails
when a generated PNG is missing, unowned, unreferenced, or shares another
entry's route/state.

| Journey | Owner | Generated asset |
| --- | --- | --- |
| Setup | Desktop onboarding | `auto/setup.png` |
| Home | Desktop workbench | `auto/home.png` |
| Chat | Runtime composition | `auto/chat.png` |
| Projects | Coordination | `auto/projects.png` |
| Team | Coworker composition | `auto/team.png` |
| Playbooks | Workflows | `auto/playbooks.png` |
| Tools & Skills | Capability catalog | `auto/tools-skills.png` |

Do not hand-edit generated images, enable default-off surfaces for public
captures, or use a personal profile. Store one-off release evidence outside
`docs/`; only screenshots referenced by durable product guidance belong here.
