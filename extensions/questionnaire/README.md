# questionnaire

Pi tool extension that adds `questionnaire`.

Use it when agent needs structured user input.

## Behavior

- single question → simple option picker
- multiple questions → tabbed flow with submit tab
- optional `allowOther` freeform input per question
- returns structured answers with selected value, label, and custom-input flag

## Parameters

Each question supports:

- `id`
- `label?`
- `prompt`
- `options[]`
- `allowOther?`

## Credits

Adapted from Pi example extension:
https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts
