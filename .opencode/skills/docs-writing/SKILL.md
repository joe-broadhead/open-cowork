---
name: docs-writing
description: "Create and edit Google Docs documents. Use when the user wants to write reports, proposals, memos, documentation, meeting notes, or any structured document. Handles creation, text insertion, formatting, tables, images, headings, lists, and find-replace."
allowed-tools: "mcp__google-docs__create mcp__google-docs__get mcp__google-docs__quick_write mcp__google-docs__insert_text mcp__google-docs__insert_table mcp__google-docs__insert_image mcp__google-docs__replace_all_text mcp__google-docs__delete_content mcp__google-docs__update_text_style mcp__google-docs__update_paragraph_style mcp__google-docs__create_bullets mcp__google-docs__insert_page_break mcp__google-docs__create_header mcp__google-docs__create_footer mcp__google-docs__insert_table_row mcp__google-docs__insert_table_column mcp__google-docs__delete_table_row mcp__google-docs__delete_table_column mcp__google-docs__update_document_style mcp__google-docs__batch_update mcp__google-docs__schema mcp__google-docs__run_api_call"
metadata:
  owner: "cowork"
  persona: "writer"
  version: "1.0.0"
---

# Docs Writing Skill

## Mission

Create professional, well-structured Google Docs documents. Handle everything from simple memos to multi-section reports with headings, tables, formatted text, and images.

## Workflow

### 1. Create the document
- Use `create` with a descriptive title
- Extract the `documentId` from the response

### 2. Write content
- **Simple text**: Use `quick_write` to append plain text (fastest for drafts)
- **Positioned text**: Use `insert_text` with a specific index for precise placement
- **Build sequentially**: Insert content from end to start, or track indices carefully

### 3. Structure with headings
- Use `update_paragraph_style` with `namedStyleType`:
  - `TITLE` — document title
  - `HEADING_1` through `HEADING_6` — section headings
  - `NORMAL_TEXT` — body text

### 4. Format text
- Use `update_text_style` for inline formatting:
  - Bold, italic, underline, strikethrough
  - Font family and size
  - Text color
  - Hyperlinks

### 5. Add structure
- **Tables**: Use `insert_table` then populate cells
- **Bullet lists**: Use `create_bullets` on a paragraph range
- **Images**: Use `insert_image` with a public URL

### 6. Advanced formatting
- **Always call `schema` first** before using `batch_update`
- Call `schema()` with no args to list all 38 available request types
- Call `schema(request_type: "createHeader")` for the exact structure
- Use `batch_update` for: headers/footers, page breaks, section breaks, table cell styles, named ranges

### 7. Share the result
- Include the document URL: `https://docs.google.com/document/d/{documentId}/edit`

## Important: Index management

Google Docs uses 1-based character indices for positioning. Key rules:
- Index `1` = beginning of the document body
- After inserting text, all subsequent indices shift by the length of the inserted text
- **Build documents from bottom to top** (insert later content first) to avoid index shifts
- Or use `get` to read the current document structure and calculate indices
- Use `replace_all_text` with placeholder tokens to avoid index management entirely

### Template pattern (recommended for complex documents)
1. Insert all text with placeholder tokens: `{{TITLE}}`, `{{SECTION_1}}`, etc.
2. Use `replace_all_text` to fill in the actual content
3. Apply formatting after all text is in place

## Tool reference

| Tool | When to use |
|---|---|
| `create` | Start a new document |
| `get` | Read document content, structure, and indices |
| `quick_write` | Append plain text to end (fast, simple) |
| `insert_text` | Insert text at a specific position |
| `insert_table` | Add a table at a position |
| `insert_image` | Add an image from a URL |
| `replace_all_text` | Find and replace text (great for templates) |
| `delete_content` | Remove content from a range |
| `update_text_style` | Bold, italic, font, color, links |
| `update_paragraph_style` | Headings, alignment, spacing |
| `create_bullets` | Bulleted or numbered lists |
| `schema` | **Call before batch_update** — live API reference |
| `batch_update` | Advanced: headers, footers, page breaks, table styles |

## Output

Always return:
- The document URL
- A summary of what was created (sections, formatting)
- The document structure (headings outline)
