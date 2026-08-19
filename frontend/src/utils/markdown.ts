import MarkdownIt from "markdown-it"
import DOMPurify from "dompurify"

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
})

const ALLOWED_TAGS = [
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "a",
  "blockquote",
  "strong",
  "em",
  "code",
  "pre",
  "hr",
]

export function renderMarkdown(content: string): string {
  if (!content || !content.trim()) return ""

  const rawHtml = md.render(content)

  const sanitized = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "target", "rel", "class"],
    ADD_TAGS: [],
    ADD_ATTR: ["class"],
  })

  return sanitized
}
