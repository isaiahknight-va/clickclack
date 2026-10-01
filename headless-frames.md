| scenario (10 s, headless 60 Hz) | build | running animations | renderer frames drawn | main-thread frames | main-thread paints |
|---|---|---|---|---|---|
| idle-channel | before | typing-dot on .typing-indicator__dots x3 | 600 | 0 | 0 |
| idle-channel | c1 | none | 0 | 0 | 0 |
| idle-channel | after | none | 0 | 0 | 0 |
| idle-dm | before | typing-dot on .typing-indicator__dots x3 | 601 | 1 | 0 |
| idle-dm | c1 | none | 0 | 0 | 0 |
| idle-dm | after | none | 0 | 0 | 0 |
| unread-bar-open | before | unread-bar-pulse on .unread-bar__jump::before x1, typing-dot on .typing-indicator__dots x3 | 600 | 600 | 1200 |
| unread-bar-open | c1 | unread-bar-pulse on .unread-bar__jump::before x1 | 600 | 600 | 1200 |
| unread-bar-open | after | none | 0 | 0 | 0 |
| embed-channel | before | none | 0 | 0 | 0 |
| embed-channel | c1 | none | 0 | 0 | 0 |
| embed-channel | after | none | 0 | 0 | 0 |
| embed-thread | before | none | 0 | 0 | 0 |
| embed-thread | c1 | none | 0 | 0 | 0 |
| embed-thread | after | none | 0 | 0 | 0 |
