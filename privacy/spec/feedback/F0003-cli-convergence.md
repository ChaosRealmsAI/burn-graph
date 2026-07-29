# F0003 — Converge the CLI around Assignments

The user requires the normal AI path to be guarded and automatic: starting or
requesting work returns complete prompt Assignments, completing one Assignment
advances the graph and returns the next one or more Assignments, and the AI
cannot manually unlock or choose an illegal Next node.

The public CLI must expose progressive JSON Help, project and graph overview,
current work, filtered inspection, recovery, Mermaid, and named Viewer
lifecycle without retaining the old manual `work claim/complete` surface.

Accepted for `0.1.0-dev.2`. Graph `maxActive` and a project default of eight
live Assignments per Actor own automatic parallelism.
