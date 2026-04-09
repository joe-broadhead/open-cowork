---
name: slides-presentations
description: "Create and edit Google Slides presentations. Use when the user wants to build slide decks, pitch decks, report presentations, or visual content. Handles slide creation, text, shapes, images, tables, styling, templates, and reordering."
allowed-tools: "mcp__google-slides__create mcp__google-slides__get mcp__google-slides__get_page mcp__google-slides__get_thumbnail mcp__google-slides__create_slide mcp__google-slides__delete_object mcp__google-slides__insert_text mcp__google-slides__create_shape mcp__google-slides__create_image mcp__google-slides__create_table mcp__google-slides__update_text_style mcp__google-slides__update_shape_properties mcp__google-slides__replace_all_text mcp__google-slides__duplicate_slide mcp__google-slides__reorder_slides mcp__google-slides__batch_update mcp__google-slides__schema"
metadata:
  owner: "cowork"
  persona: "presenter"
  version: "1.0.0"
---

# Slides Presentations Skill

## Mission

Build professional Google Slides presentations. Handle everything from simple text slides to complex layouts with images, tables, charts, and styled shapes.

## Key concepts

### EMU (English Metric Units)
Slides uses EMU for positioning and sizing:
- **1 inch = 914400 EMU**
- **1 point = 12700 EMU**
- Standard slide: 10 inches wide × 5.625 inches tall (9144000 × 5143500 EMU)

### Common positions (in EMU)
- Full-width title: x=457200, y=274650, w=8229600, h=685800
- Body text area: x=457200, y=1200150, w=8229600, h=3543300
- Left half: x=457200, y=1200150, w=3886200, h=3543300
- Right half: x=4800600, y=1200150, w=3886200, h=3543300

### Object IDs
Every element has an object ID. Use `get` to find IDs of existing elements. When creating elements, you can provide custom IDs or let the API auto-generate them.

## Workflow

### 1. Create the presentation
- Use `create` with a descriptive title
- Extract the `presentationId` and first slide's `objectId` from the response

### 2. Add slides
- Use `create_slide` to add new slides
- Optionally specify a `layoutId` from the presentation's available layouts

### 3. Add content to slides
- **Text**: Use `create_shape` (TEXT_BOX) then `insert_text` to add text to the shape
- **Images**: Use `create_image` with a public URL
- **Tables**: Use `create_table` then populate cells with `insert_text`

### 4. Style content
- **Text styling**: Use `update_text_style` for bold, italic, font, color, size
- **Shape styling**: Use `update_shape_properties` for fill color, outlines
- **Advanced**: Call `schema` then use `batch_update` for paragraph styles, page backgrounds, etc.

### 5. Template pattern (recommended)
For structured decks:
1. Create all slides first
2. Add text shapes with placeholder content: `{{TITLE}}`, `{{BODY}}`, `{{METRIC}}`
3. Use `replace_all_text` to fill in actual values
4. Apply styling last

### 6. Advanced operations
- **Always call `schema` first** before using `batch_update`
- Call `schema()` to list all 44 available request types
- Call `schema(request_type: "createSheetsChart")` for exact structure
- Use for: embedded Sheets charts, videos, speaker notes, page backgrounds, line properties

### 7. Share the result
- URL: `https://docs.google.com/presentation/d/{presentationId}/edit`

## Tool reference

| Tool | When to use |
|---|---|
| `create` | Start a new presentation |
| `get` | Read full structure, layouts, element IDs |
| `get_page` | Read a specific slide's elements |
| `get_thumbnail` | Get a thumbnail image URL for a slide |
| `create_slide` | Add a new slide |
| `delete_object` | Remove a slide or element |
| `insert_text` | Add text to a shape or table cell |
| `create_shape` | Add text boxes, rectangles, arrows, etc. |
| `create_image` | Add an image from URL |
| `create_table` | Add a data table |
| `update_text_style` | Bold, italic, font, color, size, links |
| `update_shape_properties` | Fill color, outline |
| `replace_all_text` | Find-replace across all slides |
| `duplicate_slide` | Copy a slide |
| `reorder_slides` | Move slides to new positions |
| `schema` | **Call before batch_update** — live API reference |
| `batch_update` | Advanced: charts, videos, page properties, etc. |

## Output

Always return:
- The presentation URL
- Slide count and structure summary
- Any images or charts included
