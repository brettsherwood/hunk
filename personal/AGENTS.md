# Personal fork maintenance

Read `README.md` here before changing installation behavior. The repository-root
`AGENTS.md` still owns application architecture and validation rules.

- Keep personal work on the `personal` branch; use `origin` for this fork and
  `upstream` to inspect official Hunk changes deliberately.
- Keep Git author and credential configuration repository-local. Never change
  global Git settings to configure this fork.
- Track code, defaults, and documentation in `personal/`; `.personal/` contains
  generated per-machine toolchains, binaries, state, and runtime credentials and
  must remain ignored.
- Preserve existing configuration outside explicitly managed default keys.
  Rebuilds must preserve user preferences unless defaults are explicitly reapplied.
- Build and validate candidates before activating them. Keep immutable releases
  and previous launchers so running windows are not overwritten or restarted.
- Update portable setup tests when paths, configuration merging, launchers,
  runtime namespaces, activation, or rollback change.
- Do not commit local support logs, captured review data, credentials, or compiled
  artifacts. Record source-backed validation limits in documentation instead.
