<!-- aide:tasks -->
## AIDE Task Board

You have access to a task board via the `aide-tasks` MCP server.

- Call `create_task(title, description, status)` when starting a new work item.
- Call `update_task(id, status, notes)` when completing or making progress on a task.
- Call `list_tasks(status?)` to see the current state of the board.

Keep the task board updated as work progresses. Create tasks for non-trivial work items.
<!-- /aide:tasks -->

<!-- aide:memory -->
## AIDE Memory Vault

You have access to a memory vault via the `aide-memory` MCP server.

- Call `search_memory(query)` before starting a task to retrieve relevant context.
- Call `write_memory(title, content, tags)` when you learn something worth keeping across sessions.
- Call `list_memories(tag?)` to see all stored notes.

Proactively search before answering questions about this project. Write memories after significant decisions or discoveries.
<!-- /aide:memory -->
