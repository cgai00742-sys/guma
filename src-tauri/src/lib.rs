#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Every migration here is the SQLite translation of one file in
  // supabase/migrations/. No RLS, no auth.uid() - a local install has
  // exactly one tenant, so the policies that existed to isolate shops
  // sharing a Postgres database simply have nothing to do here.
  let migrations = vec![
    tauri_plugin_sql::Migration {
      version: 1,
      description: "initial schema",
      sql: include_str!("../migrations/0001_initial.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 2,
      description: "show welcome flag",
      sql: include_str!("../migrations/0002_show_welcome.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 3,
      description: "shop state, for the tax-name helper",
      sql: include_str!("../migrations/0003_shop_state.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 4,
      description: "partner type, delivery handover, stage gates",
      sql: include_str!("../migrations/0004_partners_gates.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 5,
      description: "material purchase log and weighted-average cost",
      sql: include_str!("../migrations/0005_material_purchases.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 6,
      description: "build runs, work log, and what a project actually cost",
      sql: include_str!("../migrations/0006_actuals.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 7,
      description: "build sheet: parts, per-part QC, and their history",
      sql: include_str!("../migrations/0007_parts.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 8,
      description: "drafts: a saved job is not taken in until someone says so",
      sql: include_str!("../migrations/0008_drafts.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 9,
      description: "paper size: documents print A4 or Letter, whichever the shop uses",
      sql: include_str!("../migrations/0009_paper.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 10,
      description: "true cost: overhead allocation and a failure allowance",
      sql: include_str!("../migrations/0010_true_cost.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 11,
      description: "retire a machine without losing what it built",
      sql: include_str!("../migrations/0011_retire_machines.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
  ];

  tauri::Builder::default()
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:guma.db", migrations)
        .build(),
    )
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
