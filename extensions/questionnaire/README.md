# questionnaire

Pi tool extension that adds `questionnaire`.

Use it when agent needs structured user input with ask-style UX.

## Behavior

- single-select, multi-select, and preview-pane questions
- single or multi-question flows use tabs plus a Review tab
- every question includes inline `Type your own`
- typed answers support pi-style `@` file references
- returns normalized answers with values, labels, indices, and optional custom text

## Parameters

Each question supports:

- `id`
- `label?`
- `prompt`
- `type?`: `single` (default), `multi`, or `preview`
- `required?`: metadata only; does not block submission
- `options[]`
  - `value`
  - `label`
  - `description?`
  - `preview?` for preview-pane content

## Credits

Adapted from Pi example extension:
https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts
