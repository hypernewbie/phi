package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestConfigConcurrentAccess(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "phi-config-test")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	// Direct tests to the temp config file path
	testConfigPath = filepath.Join(tmpDir, "config.json")
	defer func() {
		testConfigPath = ""
	}()

	// Save initial config
	cfg := loadConfig()
	cfg.ThemeColor = "purple"
	saveConfig(cfg)

	// Stress concurrent reads and writes
	var wg sync.WaitGroup
	numRoutines := 50
	operationsPerRoutine := 100

	for i := 0; i < numRoutines; i++ {
		wg.Add(2)

		// Reader routine
		go func() {
			defer wg.Done()
			for j := 0; j < operationsPerRoutine; j++ {
				_ = loadConfig()
			}
		}()

		// Writer routine
		go func(id int) {
			defer wg.Done()
			for j := 0; j < operationsPerRoutine; j++ {
				c := loadConfig()
				if id%2 == 0 {
					c.ThemeColor = "gold"
				} else {
					c.ThemeColor = "cyan"
				}
				saveConfig(c)
			}
		}(i)
	}

	wg.Wait()

	// Final verification
	finalCfg := loadConfig()
	if finalCfg.ThemeColor != "gold" && finalCfg.ThemeColor != "cyan" {
		t.Errorf("Unexpected final theme color: %s", finalCfg.ThemeColor)
	}
}
