package mcp

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestMemoryTaskStore_EvictsOldestTerminalTasks(t *testing.T) {
	store := NewMemoryTaskStore()
	store.maxTasksPerSession = 2
	base := time.Now().UTC()

	for i := 0; i < 3; i++ {
		record := taskTestRecord("sess-1", fmt.Sprintf("task-%d", i), TaskStatusCompleted)
		record.Task.CreatedAt = base.Add(time.Duration(i) * time.Second)
		record.Task.LastUpdatedAt = record.Task.CreatedAt
		if _, err := store.Create(context.Background(), record); err != nil {
			t.Fatalf("Create(task-%d): %v", i, err)
		}
	}

	list, err := store.List(context.Background(), TaskListRequest{SessionID: "sess-1"})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list.Tasks) != 2 {
		t.Fatalf("task count: got %d want 2", len(list.Tasks))
	}
	if list.Tasks[0].TaskID != "task-1" || list.Tasks[1].TaskID != "task-2" {
		t.Fatalf("retained tasks: got %q, %q", list.Tasks[0].TaskID, list.Tasks[1].TaskID)
	}
	if _, err := store.Get(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "task-0"}); !errors.Is(err, ErrTaskNotFound) {
		t.Fatalf("evicted task lookup: got %v want %v", err, ErrTaskNotFound)
	}
}

func TestMemoryTaskStore_RefusesWhenAllTasksAreActive(t *testing.T) {
	store := NewMemoryTaskStore()
	store.maxTasksPerSession = 1

	if _, err := store.Create(context.Background(), taskTestRecord("sess-1", "task-active", TaskStatusWorking)); err != nil {
		t.Fatalf("Create active task: %v", err)
	}
	if _, err := store.Create(context.Background(), taskTestRecord("sess-1", "task-next", TaskStatusWorking)); !errors.Is(err, errTaskStoreCapacity) {
		t.Fatalf("Create over active cap: got %v want %v", err, errTaskStoreCapacity)
	}

	terminal := taskTestRecord("sess-1", "task-active", TaskStatusCompleted)
	if _, err := store.Update(context.Background(), terminal); err != nil {
		t.Fatalf("Update terminal: %v", err)
	}
	if _, err := store.Create(context.Background(), taskTestRecord("sess-1", "task-next", TaskStatusWorking)); err != nil {
		t.Fatalf("Create after terminal eviction: %v", err)
	}
	if _, err := store.Get(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "task-active"}); !errors.Is(err, ErrTaskNotFound) {
		t.Fatalf("terminal task should be evicted: got %v", err)
	}
}

func TestMemoryTaskStore_ReapsExpiredRecordsBeforeCapacityCheck(t *testing.T) {
	store := NewMemoryTaskStore()
	store.maxTasksPerSession = 1

	expired := taskTestRecord("sess-1", "task-expired", TaskStatusWorking)
	ttl := int64(1)
	expired.Task.TTL = &ttl
	expired.Task.CreatedAt = time.Now().UTC().Add(-time.Hour)
	if _, err := store.Create(context.Background(), expired); err != nil {
		t.Fatalf("Create expired task: %v", err)
	}

	if _, err := store.Create(context.Background(), taskTestRecord("sess-1", "task-new", TaskStatusWorking)); err != nil {
		t.Fatalf("Create after expiry reap: %v", err)
	}
	if _, err := store.Get(context.Background(), TaskLookup{SessionID: "sess-1", TaskID: "task-expired"}); !errors.Is(err, ErrTaskNotFound) {
		t.Fatalf("expired task lookup: got %v want %v", err, ErrTaskNotFound)
	}
}

func TestMemoryTaskStore_DefaultLimitLeavesSmallStoresUnchanged(t *testing.T) {
	store := NewMemoryTaskStore()
	for i := 0; i < 10; i++ {
		if _, err := store.Create(context.Background(), taskTestRecord("sess-1", fmt.Sprintf("task-%d", i), TaskStatusCompleted)); err != nil {
			t.Fatalf("Create(task-%d): %v", i, err)
		}
	}
	list, err := store.List(context.Background(), TaskListRequest{SessionID: "sess-1"})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list.Tasks) != 10 {
		t.Fatalf("task count: got %d want 10", len(list.Tasks))
	}
}
