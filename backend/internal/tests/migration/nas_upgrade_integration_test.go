package migration_test

import (
	"context"
	"io/fs"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"gorm.io/gorm"

	"video-canvas/internal/migration"
	"video-canvas/migrations"
)

func TestNASProductionUpgradeKeepsDramaData(t *testing.T) {
	db := isolatedDB(t)
	previous := migrationsThrough(t, "0044")
	addNASMigrations(t, previous, "retired_drama")
	addNASMigrations(t, previous, "nas_storage")
	if err := migration.Run(context.Background(), db, migration.Options{FS: previous}); err != nil {
		t.Fatal(err)
	}

	const title = "已有剧本"
	if err := db.Exec("INSERT INTO drama_episodes (user_id, drama_id, no, script_md, trial_plan) VALUES (7, 31, 1, ?, '{\"saved\":true}')", title).Error; err != nil {
		t.Fatal(err)
	}
	runReal(t, db)
	runReal(t, db)
	assertNASUpgrade(t, db, title)

	const retired = "0048_drama_trial_plan.sql"
	if err := db.Exec("UPDATE schema_migrations SET checksum = 'changed' WHERE filename = ?", retired).Error; err != nil {
		t.Fatal(err)
	}
	err := migration.Run(context.Background(), db, migration.Options{})
	if err == nil || !strings.Contains(err.Error(), retired) || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("历史迁移校验值不一致时应拒绝启动，得到 %v", err)
	}
}

func assertNASUpgrade(t *testing.T, db *gorm.DB, title string) {
	t.Helper()
	names := applied(t, db)
	for _, name := range []string{"0045_cli_device_code.sql", "0046_cli_device_code_ip.sql", "0047_drama_sharing.sql", "0049_reference_cache.sql", "0050_storage_hybrid_policy.sql"} {
		if !slices.Contains(names, name) {
			t.Errorf("缺少已执行的迁移 %s", name)
		}
	}
	status, err := migration.Status(context.Background(), db, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0045_drama_timing_budget.sql", "0046_drama_outline_review.sql", "0047_drama_storyboard_dialogue_review.sql", "0048_drama_trial_plan.sql"} {
		if !slices.ContainsFunc(status, func(s migration.FileStatus) bool {
			return s.Filename == name && s.Applied && !s.Unknown && !s.Modified
		}) {
			t.Errorf("旧迁移执行记录没有被识别 %s", name)
		}
	}
	var retained bool
	if err := db.Raw("SELECT script_md = ? AND trial_plan = '{\"saved\":true}'::jsonb FROM drama_episodes WHERE drama_id = 31", title).Scan(&retained).Error; err != nil || !retained {
		t.Fatalf("原剧本或试排数据丢失：保留=%v，错误=%v", retained, err)
	}
}

func TestNASFreshDatabaseSkipsRetiredDramaMigrations(t *testing.T) {
	db := isolatedDB(t)
	runReal(t, db)
	if hasColumn(t, db, "drama_episodes", "trial_plan") {
		t.Error("全新库不应应用已退役的短剧迁移")
	}
	if !hasTable(t, db, "storage_hybrid_policy") || !hasTable(t, db, "drama_viewers") {
		t.Error("全新库缺少 NAS 存储或上游的短剧共享表")
	}
	status, err := migration.Status(context.Background(), db, nil)
	if err != nil {
		t.Fatal(err)
	}
	if slices.ContainsFunc(status, func(s migration.FileStatus) bool { return s.Filename == "0048_drama_trial_plan.sql" }) {
		t.Error("全新库不应显示已退役的短剧迁移")
	}
}

func addNASMigrations(t *testing.T, dest fstest.MapFS, dir string) {
	t.Helper()
	fsys, err := fs.Sub(migrations.FS, dir)
	if err != nil {
		t.Fatal(err)
	}
	names, err := fs.Glob(fsys, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			t.Fatal(err)
		}
		dest[name] = &fstest.MapFile{Data: data}
	}
}
