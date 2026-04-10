---
name: forms-surveys
description: "Create and manage Google Forms for surveys, quizzes, and data collection. Use for building forms, adding questions, and reviewing responses."
allowed-tools: "mcp__google-forms__create mcp__google-forms__get mcp__google-forms__update mcp__google-forms__list_responses mcp__google-forms__get_response mcp__google-forms__add_question mcp__google-forms__set_publish_settings mcp__google-forms__schema mcp__google-forms__run_api_call"
metadata:
  owner: "cowork"
  persona: "analyst"
  version: "1.0.0"
---

# Forms & Surveys Skill

## Mission

Help users create Google Forms for surveys, quizzes, and data collection, then review and analyze the responses.

## Workflow

### 1. Create the form
- Use `create` with a descriptive title
- Extract the `formId` from the response

### 2. Add questions via batchUpdate
- Call `schema` first to look up the correct `batchUpdate` request format
- Use `update` (batchUpdate) to add questions, sections, images, and videos
- Add questions in logical order — group related questions together

### 3. Configure form settings
- Use `update` to set the form as a quiz, enable response collection, or add descriptions
- Set `isQuiz: true` for scored assessments with correct answers and point values

### 4. Review responses
- Use `list_responses` to get all form submissions
- Use `get_response` with a specific response ID for individual details
- Summarize results: counts, percentages, common answers

## Question types

| Type | Use for |
|---|---|
| `RADIO` | Single choice from a list |
| `CHECKBOX` | Multiple selections |
| `DROP_DOWN` | Single choice, compact display |
| `SHORT_ANSWER` | Brief text input |
| `PARAGRAPH_ANSWER` | Long-form text |
| `SCALE` | Rating (e.g., 1-5 or 1-10) |
| `DATE` | Date picker |
| `TIME` | Time picker |
| `FILE_UPLOAD` | File attachments |

## Tool reference

| Tool | When to use |
|---|---|
| `create` | Start a new form |
| `get` | Retrieve form structure and metadata |
| `update` | Add questions, sections, or change settings (batchUpdate) |
| `list_responses` | Get all submitted responses |
| `get_response` | Get a single response by ID |
| `schema` | **Call before update** — look up exact JSON format for request types |
| `run_api_call` | Execute arbitrary Forms API calls |

## Response analysis tips

- Count responses per answer choice for multiple-choice questions
- Calculate averages for scale/numeric questions
- Flag outliers or empty responses
- Present results as summary tables — pair with the `sheets-reporting` skill for dashboards

## Important rules

1. **Call `schema` before using `update`** — never guess at batchUpdate request structure
2. **Confirm the form structure** with the user before adding questions
3. **Include descriptions** on questions where the intent may be ambiguous
4. **Share the form URL** after creation: `https://docs.google.com/forms/d/{formId}/viewform`
