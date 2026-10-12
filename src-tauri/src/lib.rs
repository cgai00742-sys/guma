/// Every migration, in order. A function rather than a value because the
/// plugin takes the list by value, once per database file, and there are
/// two files -- see `run()`.
///
/// Every migration here is the SQLite translation of one file in
/// cloud/supabase/migrations/. No RLS, no auth.uid() - a local install has
/// exactly one tenant, so the policies that existed to isolate shops
/// sharing a Postgres database simply have nothing to do here.
fn migrations() -> Vec<tauri_plugin_sql::Migration> {
  vec![
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
    tauri_plugin_sql::Migration {
      version: 12,
      description: "in-house work: jobs with no client, so unbilled capacity is visible",
      sql: include_str!("../migrations/0012_in_house.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 13,
      description: "guide chapters, shown once at the moment they are needed",
      sql: include_str!("../migrations/0013_guide.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 14,
      description: "selling: products, batches, channels and sales",
      sql: include_str!("../migrations/0014_selling.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 15,
      description: "slice imports: what the slicer said, kept out of actuals",
      sql: include_str!("../migrations/0015_slice_imports.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 16,
      description: "quote builds: one quote, several machines",
      sql: include_str!("../migrations/0016_quote_builds.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 17,
      description: "a run can say which imported file it confirms",
      sql: include_str!("../migrations/0017_run_from_slice.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 18,
      description: "slice variants: one part, several machines' files",
      sql: include_str!("../migrations/0018_slice_variants.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 19,
      description: "quote revisions: why this version is above the accepted one",
      sql: include_str!("../migrations/0019_quote_revisions.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 20,
      description: "keep the sliced file itself, not just what it said",
      sql: include_str!("../migrations/0020_slice_files.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 21,
      description: "archive finished work; link a project to the one that paid for the design",
      sql: include_str!("../migrations/0021_archive_and_family.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 22,
      description: "in-house work is live from the start, not a draft",
      sql: include_str!("../migrations/0022_inhouse_live.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 23,
      description: "remember how the shop gets paid",
      sql: include_str!("../migrations/0023_sell_branch.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 24,
      description: "a stock count is a record, not an overwrite",
      sql: include_str!("../migrations/0024_stock_counts.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 25,
      description: "a project flags a price above what was agreed",
      sql: include_str!("../migrations/0025_over_ceiling.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 26,
      description: "a series holds the shop's own projects like a client holds theirs",
      sql: include_str!("../migrations/0026_series.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 27,
      description: "a gate item can be skipped with a reason",
      sql: include_str!("../migrations/0027_gate_skips.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 28,
      description: "money reads the quote that counts, one per project",
      sql: include_str!("../migrations/0028_job_money_latest.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 29,
      description: "the machine a project is booked on",
      sql: include_str!("../migrations/0029_job_printer.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 30,
      description: "material set aside for a project",
      sql: include_str!("../migrations/0030_stock_holds.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 31,
      description: "where each copy of a part has got to",
      sql: include_str!("../migrations/0031_part_copies.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 32,
      description: "each copy of a part keeps its own state",
      sql: include_str!("../migrations/0032_copy_states.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 33,
      description: "power cost per run on a mixed fleet",
      sql: include_str!("../migrations/0033_actuals_per_run_power.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 34,
      description: "a failed copy's replacement file, linked to that copy",
      sql: include_str!("../migrations/0034_copy_reprint_file.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
    tauri_plugin_sql::Migration {
      version: 35,
      description: "printed copies kept as spares when a part needs fewer",
      sql: include_str!("../migrations/0035_part_spares.sql"),
      kind: tauri_plugin_sql::MigrationKind::Up,
    },
  ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(
      // BOTH database files get the schema.
      //
      // The plugin only migrates a file it was told about. The demo
      // workspace (guma-demo.db, see src/lib/workspace.ts) was never
      // registered, so opening it gave a database with no tables at all:
      // "no such table: shops" on launch, and because the chosen workspace
      // is remembered, on every launch after that. The tests could not see
      // it -- their stand-in for the plugin migrates whatever file it is
      // handed. workspaceFiles.test.ts now reads this file and fails if a
      // workspace is added without being registered here.
      tauri_plugin_sql::Builder::default()
        .add_migrations("sqlite:guma.db", migrations())
        .add_migrations("sqlite:guma-demo.db", migrations())
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
