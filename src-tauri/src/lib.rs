#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Every migration here is the SQLite translation of one file in
  // supabase/migrations/. No RLS, no auth.uid() - a local install has
  // exactly one tenant, so the policies that existed to isolate shops
  // sharing a Postgres database simply have nothing to do here.
  let migrations = vec![tauri_plugin_sql::Migration {
    version: 1,
    description: "initial schema",
    sql: include_str!("../migrations/0001_initial.sql"),
    kind: tauri_plugin_sql::MigrationKind::Up,
  }];

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
