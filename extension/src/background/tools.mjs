const TARGET = {
  element_id: { type: "string", description: "Id from page_analyze." },
  text: { type: "string", description: "Instead of element_id: the button/link text or aria-label, e.g. \"Отправить\"." },
  label: { type: "string", description: "Instead of element_id: a field's label, placeholder or aria-label." },
  selector: { type: "string", description: "Instead of element_id: a CSS selector." },
  index: { type: "number", description: "Which match to use when several fit (0 = best).", default: 0 },
};

const TAB = { type: "number", description: "Tab id (from tab_create / tab_list). Default: the current agent tab." };

export const STEP_TOOLS = [
  "tab_create", "page_navigate", "page_wait_for", "element_click", "element_fill", "press_key",
  "page_scroll", "page_analyze", "page_extract_content", "element_get_state", "get_page_links", "tab_close", "sleep",
];

export function getAvailableTools() {
  return [
    {
      name: "run_steps",
      description:
        "Run several browser actions in ONE call, in order, and get one compact report. Use it for any " +
        "multi-step job (open page → fill → click/Enter → check), and for repeating it, e.g. sending N messages: " +
        "it is far faster than one call per action. Each step is {tool, args} with the same args as that tool; " +
        "steps without tab_id use the tab of the previous step (tab_create/page_navigate set it). " +
        "Elements can be named by text/label/selector, so page_analyze is rarely needed. " +
        "Extra step tool: sleep {ms}. Stops at the first failed step unless stop_on_error is false.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                tool: { type: "string", enum: STEP_TOOLS },
                args: { type: "object" },
              },
              required: ["tool"],
            },
          },
          stop_on_error: { type: "boolean", default: true },
          tab_id: TAB,
        },
        required: ["steps"],
      },
    },
    {
      name: "page_analyze",
      description: "List the page's interactive elements (buttons, fields, links) with ids for element_click/element_fill. Often unnecessary: those tools also accept text/label/selector.",
      inputSchema: {
        type: "object",
        properties: {
          intent_hint: { type: "string", description: "What you look for: login, search, send message, submit, menu…" },
          phase: { type: "string", enum: ["discover", "detailed"], default: "discover" },
          max_results: { type: "number", default: 5, maximum: 15 },
          element_ids: { type: "array", items: { type: "string" }, description: "Expand these ids from a discover result." },
          tab_id: TAB,
        },
        required: ["intent_hint"],
      },
    },
    {
      name: "page_extract_content",
      description: "Read the page's main text (article, search results or posts).",
      inputSchema: {
        type: "object",
        properties: {
          content_type: { type: "string", enum: ["article", "search_results", "posts"] },
          summarize: { type: "boolean", default: true, description: "false = full text (up to 40k chars)." },
          max_items: { type: "number", default: 20 },
          tab_id: TAB,
        },
        required: ["content_type"],
      },
    },
    {
      name: "element_click",
      description: "Click an element, named by element_id, text, label or selector. Waits until the page settles (up to wait_after ms).",
      inputSchema: {
        type: "object",
        properties: {
          ...TARGET,
          click_type: { type: "string", enum: ["left", "right", "double"], default: "left" },
          wait_after: { type: "number", default: 1000, description: "Max ms to wait for the page to settle." },
          tab_id: TAB,
        },
      },
    },
    {
      name: "element_fill",
      description: "Type a value into a field (input, textarea, contenteditable), named by element_id, label (placeholder) or selector. Password, code and card fields are refused.",
      inputSchema: {
        type: "object",
        properties: {
          ...TARGET,
          value: { type: "string" },
          clear_first: { type: "boolean", default: true },
          tab_id: TAB,
        },
        required: ["value"],
      },
    },
    {
      name: "press_key",
      description: "Press a key (Enter, Escape, Tab, Backspace, arrows, a letter) on an element (element_id/text/label/selector) or the focused one. Enter in chat boxes usually sends; in a form field it submits the form.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", default: "Enter" },
          modifiers: { type: "array", items: { type: "string", enum: ["ctrl", "meta", "shift", "alt"] } },
          ...TARGET,
          wait_after: { type: "number", default: 1000, description: "Max ms to wait for the page to settle." },
          tab_id: TAB,
        },
      },
    },
    {
      name: "page_navigate",
      description: "Open a URL in a tab and wait for it to load.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          wait_for: { type: "string", description: "CSS selector to wait for after load." },
          timeout: { type: "number", default: 10000 },
        },
        required: ["url"],
      },
    },
    {
      name: "page_wait_for",
      description: "Wait until an element is visible or a text appears.",
      inputSchema: {
        type: "object",
        properties: {
          condition_type: { type: "string", enum: ["element_visible", "text_present"] },
          selector: { type: "string" },
          text: { type: "string" },
          timeout: { type: "number", default: 5000 },
        },
        required: ["condition_type"],
      },
    },
    {
      name: "tab_create",
      description: "Open a new tab (url) or several (urls) and wait for loading. The tab id it returns is the agent's tab.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          urls: { type: "array", items: { type: "string" }, maxItems: 100 },
          active: { type: "boolean", default: true },
          wait_for: { type: "string", description: "CSS selector to wait for (single tab)." },
          timeout: { type: "number", default: 10000 },
        },
      },
    },
    {
      name: "tab_close",
      description: "Close tab(s) by id, or the current agent tab.",
      inputSchema: {
        type: "object",
        properties: { tab_id: { type: "number" }, tab_ids: { type: "array", items: { type: "number" } } },
      },
    },
    {
      name: "tab_list",
      description: "List open tabs with ids.",
      inputSchema: {
        type: "object",
        properties: { current_window_only: { type: "boolean", default: true } },
      },
    },
    {
      name: "tab_switch",
      description: "Bring a tab to the front.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } }, required: ["tab_id"] },
    },
    {
      name: "element_get_state",
      description: "Get an element's state and value (element_id, text, label or selector).",
      inputSchema: { type: "object", properties: { ...TARGET, tab_id: TAB } },
    },
    {
      name: "page_scroll",
      description: "Scroll the page (direction/amount) or to an element.",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "left", "right", "top", "bottom"], default: "down" },
          amount: { type: "string", enum: ["small", "medium", "large", "page", "custom"], default: "medium" },
          pixels: { type: "number" },
          element_id: { type: "string" },
          tab_id: TAB,
        },
      },
    },
    {
      name: "get_page_links",
      description: "List the page's links.",
      inputSchema: {
        type: "object",
        properties: {
          include_internal: { type: "boolean", default: true },
          include_external: { type: "boolean", default: true },
          domain_filter: { type: "string" },
          max_results: { type: "number", default: 100, maximum: 200 },
          tab_id: TAB,
        },
      },
    },
    {
      name: "get_selected_text",
      description: "Get the text the user selected in a tab.",
      inputSchema: { type: "object", properties: { max_length: { type: "number", default: 10000 }, tab_id: TAB } },
    },
    {
      name: "get_bookmarks",
      description: "Search bookmarks.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
    {
      name: "add_bookmark",
      description: "Add a bookmark.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, url: { type: "string" }, parentId: { type: "string" } },
        required: ["title", "url"],
      },
    },
    {
      name: "get_history",
      description: "Search browser history.",
      inputSchema: {
        type: "object",
        properties: {
          keywords: { type: "string" },
          start_date: { type: "string", format: "date-time" },
          end_date: { type: "string", format: "date-time" },
          domains: { type: "array", items: { type: "string" } },
          max_results: { type: "number", default: 50, maximum: 500 },
        },
      },
    },
  ];
}
