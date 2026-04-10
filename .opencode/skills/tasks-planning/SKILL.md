---
name: tasks-planning
description: "Manage Google Tasks for personal task tracking, to-do lists, and project planning."
allowed-tools: "mcp__google-tasks__list_task_lists mcp__google-tasks__get_task_list mcp__google-tasks__create_task_list mcp__google-tasks__rename_task_list mcp__google-tasks__delete_task_list mcp__google-tasks__list_tasks mcp__google-tasks__get_task mcp__google-tasks__create_task mcp__google-tasks__update_task mcp__google-tasks__delete_task mcp__google-tasks__complete_task mcp__google-tasks__clear_completed mcp__google-tasks__move_task mcp__google-tasks__schema mcp__google-tasks__run_api_call"
metadata:
  owner: "cowork"
  persona: "assistant"
  version: "1.0.0"
---

# Tasks Planning Skill

## Mission

Help users manage their to-do lists, track tasks, and stay organized with Google Tasks.

## Workflow

### 1. Find or create a task list
- Use `list_task_lists` to see all existing lists
- Use `create_task_list` to start a new list for a project or category
- The default task list ("My Tasks") is always available

### 2. Add and update tasks
- Use `create_task` with a clear title, optional notes, and due date
- Use `update_task` to change title, notes, due date, or status
- Use `move_task` to reorder tasks or nest them as subtasks

### 3. Mark tasks complete
- Use `complete_task` to mark a task as done
- Use `clear_completed` to remove all completed tasks from a list

### 4. Clean up
- Use `delete_task` to remove individual tasks
- Use `delete_task_list` to remove an entire list that's no longer needed

## Due date formatting

- Use RFC 3339 date format: `2026-04-10T00:00:00.000Z`
- Due dates are date-only in Google Tasks — the time portion is ignored
- When a user says "tomorrow", "next Friday", etc., convert to the correct date

## Task organization tips

- **One list per project or area**: "Work", "Personal", "Project X"
- **Use subtasks** (via `move_task` with `parent`) to break down large tasks
- **Add notes** for context: links, acceptance criteria, or details
- **Set due dates** on time-sensitive tasks to surface them in calendar views

## Tool reference

| Tool | When to use |
|---|---|
| `list_task_lists` | See all task lists |
| `create_task_list` | Start a new list for a project or category |
| `delete_task_list` | Remove an entire list |
| `list_tasks` | See all tasks in a list |
| `get_task` | Get full details of a specific task |
| `create_task` | Add a new task |
| `update_task` | Change title, notes, due date, or status |
| `delete_task` | Remove a single task |
| `complete_task` | Mark a task as done |
| `clear_completed` | Remove all completed tasks from a list |
| `move_task` | Reorder tasks or create subtask hierarchy |
| `schema` | Look up API formats for advanced operations |
| `run_api_call` | Execute arbitrary Tasks API calls |

## Important rules

1. **Confirm before deleting** — always verify before calling `delete_task` or `delete_task_list`
2. **Show the current list** before making bulk changes so the user can review
3. **Preserve existing tasks** — never clear or delete tasks without explicit permission
4. **Include due dates** when the user mentions any time reference
