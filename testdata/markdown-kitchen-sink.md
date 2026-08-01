# Markdown kitchen sink

Manual test fixture — every element the viewer should handle. Open in the modal AND the popup; both must render identically and stay XSS-inert.

## Headings

### Level 3

#### Level 4

##### Level 5

###### Level 6

## Emphasis

*italic* — **bold** — ***bold italic*** — ~~strikethrough~~ — `inline code` — **bold with `code` inside**

## Lists

1. Ordered one
2. Ordered two
   1. Nested ordered
   2. With *emphasis*
3. Ordered three

- Unordered
- With a nested list:
  - Deeper
    - Deepest
- Back to top level

### Task list (GFM)

- [x] Done item
- [ ] Pending item

## Links and autolinks

[Inline link](https://example.com) — [link with title](https://example.com "hover title") — autolink: https://example.com/auto

## Table (GFM)

| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | c     |
| *italic* | `code` | **bold** |
| long cell content that may wrap around | short | 12345 |

## Blockquotes

> Single level quote.
>
> > Nested quote with `code`.
>
> Back to level one.

## Code fences

```javascript
// hljs should colorize this
const x = { a: 1, b: [2, 3] };
export function hello(name) {
    return `hi ${name}`;
}
```

```go
// and this
func main() {
	fmt.Println("phi")
}
```

```bash
echo "no-frills shell" && ls -la | head -3
```

```
plain fence, no language tag
```

## Images

Local relative (needs test-image.png next to this file — must load via /api/markdown/asset):

![local test image](./test-image.png)

Local with ./ prefix and query suffix (suffix must be stripped):

![local with query](./test-image.png?v=2)

Remote (src must stay untouched by the rewrite):

![remote](https://raw.githubusercontent.com/github/explore/main/topics/go/go.png)

## Raw HTML passthrough (allowed subset)

Keyboard: <kbd>Ctrl</kbd>+<kbd>C</kbd> — superscript: x<sup>2</sup> — subscript: H<sub>2</sub>O

<details>
<summary>Collapsible details element</summary>

Hidden content with **markdown** inside.

</details>

## Sanitizer probes (ALL must be inert — no PWNED title, no alert)

<script>document.title = 'PWNED-script'</script>

<img src=x onerror="document.title='PWNED-onerror'">

<iframe src="https://example.com"></iframe>

<a href="javascript:document.title='PWNED-href'">javascript: link (click me — nothing should happen)</a>

<div style="position:fixed;inset:0;background:red">style attr must be stripped — if the page turns red, the sanitizer failed</div>

## Horizontal rule

---

## Line breaks

Line one with two trailing spaces  
forced break above (breaks:false, so a bare newline
does NOT break this line).

## Long block for scroll testing

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Repeat this section mentally ~50×, or just append lines while the popup is open to watch live-refresh preserve your scroll position.
