// Browser automation content script. Fills React-controlled editors via
// execCommand, which they accept where programmatic value writes are ignored.
// Import WebExtension polyfill for cross-browser compatibility
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
  globalThis.browser = chrome;
}

// Prevent multiple injections - especially important for Firefox
if (typeof window.OpenDiaContentScriptLoaded !== 'undefined') {
  console.log("OpenDia content script already loaded, skipping re-injection");
} else {
  window.OpenDiaContentScriptLoaded = true;

console.log("OpenDia enhanced content script loaded");

// Anti-Detection Platform Configuration
const ANTI_DETECTION_PLATFORMS = {
  "twitter.com": {
    selectors: {
      textarea: "[data-testid='tweetTextarea_0']",
      submit: "[data-testid='tweetButtonInline'], [data-testid='tweetButton']",
    },
    bypassMethod: "twitter_direct",
  },
  "x.com": {
    selectors: {
      textarea: "[data-testid='tweetTextarea_0']",
      submit: "[data-testid='tweetButtonInline'], [data-testid='tweetButton']",
    },
    bypassMethod: "twitter_direct",
  },
  // Add other platforms that need special handling
  "linkedin.com": {
    selectors: {
      textarea: "[contenteditable='true'][role='textbox']",
      submit: "[data-control-name='share.post']",
    },
    bypassMethod: "linkedin_direct",
  },
  "facebook.com": {
    selectors: {
      textarea: "[contenteditable='true'][data-text='true']",
      submit: "[data-testid='react-composer-post-button']",
    },
    bypassMethod: "facebook_direct",
  },
};

// claude-for-arc: fields whose contents must never be read or written by the model.
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)(\s|$)/i;
const SENSITIVE_NAME = /(^|[^a-z])(pass(word|wd|code|phrase)?|pwd|pin|cvv|cvc|csc|otp|2fa|totp)([^a-z]|$)|card.?number|security.?code/i;

function isSensitiveField(element) {
  if (!element || element.tagName !== "INPUT" && element.tagName !== "TEXTAREA") return false;
  if ((element.type || "").toLowerCase() === "password") return true;
  if (SENSITIVE_AUTOCOMPLETE.test(element.getAttribute("autocomplete") || "")) return true;
  // Split camelCase so "userPassword" reads as "user Password" but "shipping" stays one word.
  const label = [element.name, element.id, element.getAttribute("aria-label")]
    .filter(Boolean)
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return SENSITIVE_NAME.test(label);
}

// claude-for-arc: readable text of an element. textContent (used upstream)
// includes the source of <style> and <script> tags, which on heavy sites is
// most of the page; innerText is what the user actually sees. Capped so one
// page cannot flood the conversation.
const MAX_TEXT_CHARS = 40000;

function readableText(element, maxChars = MAX_TEXT_CHARS) {
  if (!element) return "";
  let text = typeof element.innerText === "string" ? element.innerText : "";
  if (!text.trim()) {
    // Not rendered (e.g. display:none): fall back to text nodes outside
    // style/script/template/svg.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest("style, script, noscript, template, svg")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    const parts = [];
    while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
    text = parts.join(" ");
  }
  text = text
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n… [claude-for-arc: обрезано, всего ${text.length} символов]`;
  }
  return text;
}

// Upper bound per element registry, so a long-lived tab can't grow it forever.
const MAX_REGISTRY_ENTRIES = 1000;

// claude-for-arc: actions whose element can be named by text / label / selector.
const TARGETED_ACTIONS = new Set(["element_click", "element_fill", "get_element_state", "press_key"]);
const MAX_FILE_BYTES = 1024 * 1024;
const FILE_PICKER_INSTRUCTIONS =
  "Системный диалог выбора файла открывает пользователь. Для автоматического заполнения передайте имя и содержимое через element_fill(file).";

// Resolves once the DOM has been quiet for QUIET_MS, or after maxMs at most.
const QUIET_MS = 120;
function settle(maxMs) {
  if (maxMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let quietTimer;
    const done = () => { observer.disconnect(); clearTimeout(quietTimer); clearTimeout(capTimer); resolve(); };
    const observer = new MutationObserver(() => { clearTimeout(quietTimer); quietTimer = setTimeout(done, QUIET_MS); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    quietTimer = setTimeout(done, QUIET_MS);
    const capTimer = setTimeout(done, maxMs);
  });
}

const norm = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

function isShown(element) {
  if (!element.isConnected || element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
}

function nativeOptionIsShown(option) {
  const select = option.closest("select");
  if (!select || !isShown(select) || option.closest("[hidden]")) return false;
  const style = getComputedStyle(option);
  return style.display !== "none" && style.visibility !== "hidden";
}

function nativeOptionIsEnabled(option) {
  return !option.disabled && !option.closest("optgroup[disabled]");
}

const CLICKABLE =
  'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], ' +
  '[role="checkbox"], [role="switch"], input[type="submit"], input[type="button"], input[type="checkbox"], ' +
  'input[type="radio"], summary, label, [onclick], [tabindex]:not([tabindex="-1"])';
const FIELDS =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), ' +
  'textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"]';

// How well a candidate's names match the wanted text: 3 exact, 2 prefix, 1 contains.
function matchScore(names, wanted) {
  let best = 0;
  for (const name of names) {
    const n = norm(name);
    if (!n) continue;
    if (n === wanted) return 3;
    if (n.startsWith(wanted)) best = Math.max(best, 2);
    else if (n.includes(wanted)) best = Math.max(best, 1);
  }
  return best;
}

function clickableNames(element) {
  return [
    element.getAttribute("aria-label"),
    element.innerText,
    element.value,
    element.getAttribute("title"),
    element.getAttribute("alt"),
    element.querySelector?.("img[alt]")?.getAttribute("alt"),
    element.querySelector?.("svg title")?.textContent,
  ];
}

function fieldNames(element) {
  const names = [
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("aria-placeholder"),
    element.getAttribute("data-placeholder"),
    element.getAttribute("title"),
    element.getAttribute("name"),
    element.id,
  ];
  for (const label of element.labels || []) names.push(label.innerText);
  for (const id of (element.getAttribute("aria-labelledby") || "").split(/\s+/)) {
    if (id) names.push(document.getElementById(id)?.innerText);
  }
  return names;
}

class BrowserAutomation {
  constructor() {
    this.elementRegistry = new Map();
    this.quickRegistry = new Map(); // For phase 1 quick matches
    this.idCounter = 0;
    this.quickIdCounter = 0;
    this.setupMessageListener();
  }

  setupMessageListener() {
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            success: false,
            error: error.message,
            stack: error.stack,
          });
        });
      return true; // Keep message channel open for async response
    });
  }

  async handleMessage(message) {
    const { action, data } = message;
    const startTime = performance.now();

    try {
      // claude-for-arc: element actions may name the element directly (button
      // text, field label or placeholder, CSS selector) instead of an id from
      // page_analyze, which saves a whole round trip per action.
      if (TARGETED_ACTIONS.has(action) && data && !data.element_id && (data.selector || data.text || data.label)) {
        data.element_id = this.registerElement(this.findTarget(data, action));
      }
      let result;
      switch (action) {
        case "press_key":
          result = await this.pressKey(data);
          break;
        case "analyze":
          result = await this.analyzePage(data);
          break;
        case "extract_content":
          result = await this.extractContent(data);
          break;
        case "element_click":
          result = await this.clickElement(data);
          break;
        case "element_fill": {
          // claude-for-arc: passwords, one-time codes and card data are typed
          // by the user, never by the model.
          const target = this.getElementById(data.element_id);
          if (target && isSensitiveField(target)) {
            throw new Error(
              "claude-for-arc: это поле для пароля, кода или данных карты — его заполняет только пользователь"
            );
          }
          result = await this.fillElementWithAntiDetection(data);
          break;
        }
        case "wait_for":
          result = await this.waitForCondition(data);
          break;
        case "get_element_state":
          const element = this.getElementById(data.element_id);
          if (!element) {
            throw new Error(`Element not found: ${data.element_id}`);
          }
          result = {
            element_id: data.element_id,
            element_name: this.getElementName(element),
            state: this.getElementState(element),
            current_value: isSensitiveField(element)
              ? "[скрыто claude-for-arc]"
              : this.getElementValue(element),
          };
          break;
        case "get_page_links":
          result = await this.getPageLinks(data);
          break;
        case "page_scroll":
          result = await this.scrollPage(data);
          break;
        case "page_style":
          result = await this.handlePageStyle(data);
          break;
        case "ping":
          // Health check for background tab content script readiness
          result = { status: "ready", timestamp: Date.now(), url: window.location.href };
          break;
        default:
          throw new Error(`Unknown action: ${action}`);
      }

      const executionTime = performance.now() - startTime;
      const dataSize = new Blob([JSON.stringify(result)]).size;

      return {
        success: true,
        data: result,
        execution_time: Math.round(executionTime),
        data_size: dataSize,
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        stack: error.stack,
        execution_time: Math.round(performance.now() - startTime),
      };
    }
  }

  // 🎯 ANTI-DETECTION BYPASS METHOD
  async fillElementWithAntiDetection({
    element_id,
    value,
    file,
    clear_first = true,
    force_focus = true,
  }) {
    const element = this.getElementById(element_id);
    if (!element) {
      throw new Error(`Element not found: ${element_id}`);
    }

    if (element.matches('input[type="file"]')) {
      if (file == null || value !== undefined) throw new Error(FILE_PICKER_INSTRUCTIONS);
      return this.attachFile(element, element_id, file);
    }
    if (file !== undefined || typeof value !== "string") {
      throw new Error("Для этого поля передайте строку в value. Параметр file доступен только для input[type=file].");
    }
    if (element.tagName === "SELECT") {
      return this.fillNativeSelect(element, element_id, value);
    }

    const hostname = window.location.hostname;
    const platformConfig = this.detectAntiDetectionPlatform(hostname);

    if (platformConfig && this.shouldUseBypass(element, platformConfig)) {
      console.log(
        `🎯 Using ${platformConfig.bypassMethod} bypass for ${hostname}`
      );
      return await this.executeDirectBypass(
        element,
        value,
        platformConfig,
        element_id
      );
    } else {
      // Use normal fillElement for non-detection platforms
      console.log("🔧 Using standard fill method");
      return await this.fillElementStandard({
        element_id,
        value,
        clear_first,
        force_focus,
      });
    }
  }

  attachFile(input, elementId, { name, base64, mime_type: mimeType }) {
    if (this.isElementDisabled(input)) throw new Error("Поле выбора файла выключено.");
    if (typeof name !== "string" || !name.trim() || name.length > 255 ||
        name === "." || name === ".." || /[\/\\\x00-\x1f\x7f]/.test(name)) {
      throw new Error("Укажите имя файла без пути.");
    }
    if (typeof base64 !== "string" || base64.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)) {
      throw new Error("Передайте содержимое файла в base64. Максимальный размер файла 1 МиБ.");
    }
    if (mimeType !== undefined && (typeof mimeType !== "string" || mimeType.length > 127)) {
      throw new Error("Некорректный MIME-тип файла.");
    }
    let decoded;
    try {
      decoded = atob(base64);
    } catch {
      throw new Error("Некорректное содержимое base64.");
    }
    if (decoded.length > MAX_FILE_BYTES) throw new Error("Максимальный размер файла 1 МиБ.");
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type: mimeType }));
    input.files = transfer.files;
    if (input.files.length !== 1 || input.files[0].name !== name) {
      throw new Error("Не удалось прикрепить файл к полю.");
    }
    // A site can clear the field in its change handler after consuming the file.
    this.dispatchValueChange(input);
    return {
      success: true,
      element_id: elementId,
      element_name: this.getElementName(input),
      actual_value: name,
      method: "file_attachment",
    };
  }

  fillNativeSelect(select, elementId, value) {
    if (this.isElementDisabled(select)) throw new Error("Выпадающий список выключен.");
    const options = [...select.options].filter(option => nativeOptionIsEnabled(option) && nativeOptionIsShown(option));
    const option = options.find(candidate => candidate.value === value) ||
      options.find(candidate => norm(candidate.label) === norm(value));
    if (!option) throw new Error("В списке нет доступного варианта с таким значением или названием.");
    this.selectNativeOption(select, option);
    return {
      success: select.selectedIndex === option.index,
      element_id: elementId,
      element_name: this.getElementName(select),
      actual_value: select.value,
      method: "native_select",
    };
  }

  dispatchValueChange(element) {
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  selectNativeOption(select, option) {
    if (select.selectedIndex === option.index && select.selectedOptions.length === 1) return;
    select.selectedIndex = option.index;
    this.dispatchValueChange(select);
  }

  detectAntiDetectionPlatform(hostname) {
    // Check exact matches first
    if (ANTI_DETECTION_PLATFORMS[hostname]) {
      return ANTI_DETECTION_PLATFORMS[hostname];
    }

    // Check subdomain matches
    for (const [domain, config] of Object.entries(ANTI_DETECTION_PLATFORMS)) {
      if (hostname.includes(domain) || hostname.endsWith(`.${domain}`)) {
        return config;
      }
    }

    return null;
  }

  shouldUseBypass(element, platformConfig) {
    // Check if element matches platform-specific selectors
    try {
      const isTextarea =
        document.querySelector(platformConfig.selectors.textarea) === element;
      if (isTextarea) return true;

      // Also check if element matches any textarea selector pattern
      const textareaSelectors = platformConfig.selectors.textarea.split(", ");
      return textareaSelectors.some((selector) => {
        try {
          return element.matches(selector);
        } catch {
          return false;
        }
      });
    } catch (error) {
      console.warn("Bypass detection failed:", error);
      return false;
    }
  }

  async executeDirectBypass(element, value, platformConfig, element_id) {
    try {
      console.log(`🔓 Executing ${platformConfig.bypassMethod} bypass`);

      switch (platformConfig.bypassMethod) {
        case "twitter_direct":
          return await this.twitterDirectBypass(element, value, element_id);
        case "linkedin_direct":
          return await this.linkedinDirectBypass(element, value, element_id);
        case "facebook_direct":
          return await this.facebookDirectBypass(element, value, element_id);
        default:
          // Generic direct bypass
          return await this.genericDirectBypass(element, value, element_id);
      }
    } catch (error) {
      console.error(
        "Direct bypass failed, falling back to standard method:",
        error
      );
      return await this.fillElementStandard({
        element_id,
        value,
        clear_first: true,
        force_focus: true,
      });
    }
  }

  async twitterDirectBypass(element, value, element_id) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await new Promise((r) => setTimeout(r, 200));

    // Draft.js ignores programmatic .value writes and synthesized input events.
    // execCommand("insertText") produces a trusted beforeinput, which the editor's
    // own handler accepts and mirrors into React state. Focus and click first:
    // the handler is only attached once the editor considers itself active.
    element.focus();
    element.click();
    const execResult = document.execCommand("insertText", false, value);

    // The editor commits on its next render; reading sooner sees the old value.
    await new Promise((r) => setTimeout(r, 500));

    const currentText = element.textContent || element.value || "";
    const success = currentText.includes(value);

    return {
      success: success,
      element_id: element_id,
      value: value,
      actual_value: currentText,
      method: "twitter_direct_bypass",
      execCommand_result: execResult,
      element_name: this.getElementName(element),
    };
  }

  async linkedinDirectBypass(element, value, element_id) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await new Promise((r) => setTimeout(r, 200));

    element.focus();
    element.click();

    // LinkedIn's editor appends rather than replaces, so clear before inserting.
    if (element.textContent) {
      document.execCommand("selectAll");
      document.execCommand("delete");
    }

    const execResult = document.execCommand("insertText", false, value);

    // Slower to commit than Twitter's; 500ms reads back a partial value.
    await new Promise((r) => setTimeout(r, 800));

    const currentText = element.textContent || element.value || "";
    const success = currentText.includes(value);

    return {
      success: success,
      element_id: element_id,
      value: value,
      actual_value: currentText,
      method: "linkedin_direct_bypass",
      execCommand_result: execResult,
      element_name: this.getElementName(element),
    };
  }

  async facebookDirectBypass(element, value, element_id) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await new Promise((r) => setTimeout(r, 200));

    element.focus();
    element.click();

    if (element.textContent) {
      document.execCommand("selectAll");
      document.execCommand("delete");
    }

    const execResult = document.execCommand("insertText", false, value);

    // Facebook's composer also listens for these directly, unlike Twitter's,
    // which picks the change up from beforeinput alone.
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 600));

    const currentText = element.textContent || element.value || "";
    const success = currentText.includes(value);

    return {
      success: success,
      element_id: element_id,
      value: value,
      actual_value: currentText,
      method: "facebook_direct_bypass",
      execCommand_result: execResult,
      element_name: this.getElementName(element),
    };
  }

  // Reached only if a platform config names a bypassMethod without its own case.
  // Kept as the extension point for adding a platform to ANTI_DETECTION_PLATFORMS.
  async genericDirectBypass(element, value, element_id) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    await new Promise((r) => setTimeout(r, 200));

    element.focus();
    element.click();
    const execResult = document.execCommand("insertText", false, value);

    await new Promise((r) => setTimeout(r, 500));

    const currentText = element.textContent || element.value || "";
    const success = currentText.includes(value);

    return {
      success: success,
      element_id: element_id,
      value: value,
      actual_value: currentText,
      method: "generic_direct_bypass",
      execCommand_result: execResult,
      element_name: this.getElementName(element),
    };
  }

  // Standard fill method (unchanged for compatibility)
  async fillElementStandard({
    element_id,
    value,
    clear_first = true,
    force_focus = true,
  }) {
    const element = this.getElementById(element_id);
    if (!element) {
      throw new Error(`Element not found: ${element_id}`);
    }

    // Modern editors attach their input handler on focus, not on load.
    if (force_focus) {
      await this.ensureProperFocus(element);
    } else {
      element.focus();
    }

    // Clear existing content if requested
    if (clear_first) {
      await this.clearElementContent(element);
    }

    // Fill the value with proper event sequence
    await this.fillWithEvents(element, value);

    // Validate the fill was successful
    const actualValue = this.getElementValue(element);
    const success = actualValue.includes(value);

    return {
      success,
      element_id,
      value,
      actual_value: actualValue,
      element_name: this.getElementName(element),
      method: "standard_fill",
      focus_applied: force_focus,
    };
  }

  async analyzePage({
    intent_hint,
    phase = "discover",
    focus_areas,
    element_ids,
    max_results, // each phase applies its own default (discover 5, detailed 10)
  }) {
    this.pruneRegistries();

    // The phase enum is discover|detailed on both sides of the wire, so the
    // dispatch is total.
    if (phase === "detailed") {
      return await this.detailedAnalysis({
        intent_hint,
        focus_areas,
        element_ids,
        max_results: max_results ?? 10,
      });
    }
    return await this.quickDiscovery({ intent_hint, max_results: max_results ?? 5 });
  }

  async quickDiscovery({ intent_hint, max_results = 5 }) {
    const startTime = performance.now();

    // Detect page type and get basic metrics
    const pageType = this.detectPageType();
    const viewportElements = this.countViewportElements();

    // Use default max results limit
    max_results = Math.min(max_results, 10); // claude-for-arc: was 5

    // Try to find obvious matches using enhanced patterns
    let quickMatches = [];
    let usedMethod = "quick_discovery";

    try {
      // Check for anti-detection bypass first
      const hostname = window.location.hostname;
      const platformConfig = this.detectAntiDetectionPlatform(hostname);

      if (
        platformConfig &&
        (intent_hint.includes("post") || intent_hint.includes("tweet"))
      ) {
        const bypassResult = await this.tryAntiDetectionPatterns(
          intent_hint,
          platformConfig
        );
        if (bypassResult.confidence > 0.9) {
          quickMatches = bypassResult.elements
            .slice(0, 3)
            .map((el) => this.compressElement(el, true));
          usedMethod = "anti_detection_bypass";
        }
      }

    } catch (error) {
      console.warn("Anti-detection pattern matching failed:", error);
    }

    // If no pattern matches, do a quick viewport scan
    if (quickMatches.length === 0) {
      quickMatches = await this.quickViewportScan(intent_hint, max_results);
      usedMethod = "viewport_scan";
    }

    const intentMatch = this.scoreIntentMatch(intent_hint, quickMatches);
    const suggestedAreas = this.suggestPhase2Areas(quickMatches, intent_hint);
    const executionTime = Math.round(performance.now() - startTime);

    const result = {
      summary: {
        page_type: pageType,
        intent_match: intentMatch,
        element_count: viewportElements,
        viewport_elements: quickMatches.length,
        suggested_phase2: suggestedAreas,
        anti_detection_platform: this.detectAntiDetectionPlatform(
          window.location.hostname
        )
          ? window.location.hostname
          : null,
      },
      quick_matches: quickMatches,
      token_estimate: this.estimatePhase2Tokens(quickMatches),
      method: usedMethod,
      execution_time: executionTime,
      intent_hint: intent_hint, // Add this for server.js compatibility
      elements: quickMatches, // Add this for backward compatibility
    };


    return result;
  }

  async tryAntiDetectionPatterns(intent_hint, platformConfig) {
    const elements = [];

    // Try to find platform-specific elements
    try {
      const textareaElement = document.querySelector(
        platformConfig.selectors.textarea
      );
      if (textareaElement && this.isLikelyVisible(textareaElement)) {
        const elementId = this.registerElement(textareaElement);
        elements.push({
          id: elementId,
          type: "textarea",
          selector: platformConfig.selectors.textarea,
          name: this.getElementName(textareaElement),
          confidence: 0.95, // High confidence for anti-detection platforms
          element: textareaElement,
        });
      }

      const submitElement = document.querySelector(
        platformConfig.selectors.submit
      );
      if (submitElement && this.isLikelyVisible(submitElement)) {
        const elementId = this.registerElement(submitElement);
        elements.push({
          id: elementId,
          type: "button",
          selector: platformConfig.selectors.submit,
          name: this.getElementName(submitElement),
          confidence: 0.95,
          element: submitElement,
        });
      }
    } catch (error) {
      console.warn("Anti-detection pattern matching failed:", error);
    }

    return {
      elements,
      confidence: elements.length > 0 ? 0.95 : 0,
      method: "anti_detection_patterns",
      platform: window.location.hostname,
    };
  }

  async detailedAnalysis({
    intent_hint,
    focus_areas,
    element_ids,
    max_results = 10,
  }) {
    const startTime = performance.now();

    // Use default max results limit  
    max_results = Math.min(max_results, 30); // claude-for-arc: was capped at 7

    let elements = [];
    let method = "detailed_analysis";

    // Expand specific quick matches if provided
    if (element_ids?.length) {
      elements = await this.expandQuickMatches(element_ids);
      method = "expanded_matches";
    }

    // Analyze specific focus areas
    if (focus_areas?.length) {
      const areaElements = await this.analyzeFocusAreas(
        focus_areas,
        intent_hint
      );
      elements = [...elements, ...areaElements];
      method = elements.length > 0 ? "focus_area_analysis" : method;
    }

    // If no specific analysis requested, do full enhanced analysis
    if (elements.length === 0) {
      elements = await this.fullEnhancedAnalysis(intent_hint, max_results);
      method = "full_enhanced_analysis";
    }

    // Deduplicate and enhance with metadata
    elements = this.deduplicateElements(elements);
    elements = await this.enhanceElementMetadata(elements);

    // Apply compact fingerprinting
    elements = elements
      .slice(0, max_results)
      .map((el) => this.compressElement(el, false));

    const executionTime = Math.round(performance.now() - startTime);
    const result = {
      elements,
      interaction_ready: elements.every((el) => el.conf > 50),
      method,
      execution_time: executionTime,
      intent_hint: intent_hint, // Add this for server.js compatibility
    };


    return result;
  }

  async extractContent({ content_type, max_items = 20, summarize = true }) {
    const startTime = performance.now();
    const extractors = {
      article: () => this.extractArticleContent(summarize),
      search_results: () => this.extractSearchResults(max_items, summarize),
      posts: () => this.extractPosts(max_items, summarize),
    };

    const extractor = extractors[content_type];
    if (!extractor) {
      throw new Error(`Unknown content type: ${content_type}`);
    }

    const rawContent = extractor();

    if (summarize) {
      // Return summary instead of full content to save tokens
      return {
        content_type,
        summary: this.summarizeContent(rawContent, content_type),
        items_found: Array.isArray(rawContent) ? rawContent.length : 1,
        sample_items: Array.isArray(rawContent)
          ? rawContent.slice(0, 3)
          : [rawContent],
        extraction_method: this.getExtractionMethod(content_type),
        token_estimate: this.estimateContentTokens(rawContent),
        execution_time: Math.round(performance.now() - startTime),
        extracted_at: new Date().toISOString(),
      };
    } else {
      // Full content, returned when summarize is false
      return {
        content: rawContent,
        method: "semantic_extraction",
        content_type: content_type,
        execution_time: Math.round(performance.now() - startTime),
        extracted_at: new Date().toISOString(),
      };
    }
  }

  extractArticleContent(summarize = true) {
    const article = document.querySelector(
      'article, [role="article"], .article-content, main'
    );
    const title = document
      .querySelector("h1, .article-title, .post-title")
      ?.innerText?.trim();
    const content = readableText(article) || this.extractMainContent();


    return {
      title,
      content,
      word_count: content?.split(/\s+/).length || 0,
    };
  }

  extractMainContent() {
    // Simple heuristic to find main content
    const candidates = document.querySelectorAll(
      "main, .content, .post-content, .article-body"
    );
    let bestCandidate = null;
    let maxTextLength = 0;

    for (const candidate of candidates) {
      const textLength = readableText(candidate, Infinity).length;
      if (textLength > maxTextLength) {
        maxTextLength = textLength;
        bestCandidate = candidate;
      }
    }

    return (
      readableText(bestCandidate) || readableText(document.body)
    );
  }

  extractSearchResults(max_items = 20, summarize = true) {
    // Common search result patterns
    const selectors = [
      '.search-result, .result-item, [data-testid*="result"]',
      ".g, .result, .search-item", // Google-style
      'li[data-testid="search-result"], .SearchResult', // Twitter/X
      ".Box-row, .issue-list-item", // GitHub
      "article, .post, .entry", // Generic content
    ];

    let results = [];
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        results = Array.from(elements)
          .slice(0, max_items)
          .map((el, index) => ({
            index: index + 1,
            title: this.extractResultTitle(el, summarize),
            summary: this.extractResultSummary(el, summarize),
            link: this.extractResultLink(el),
            type: this.detectResultType(el),
            score: this.scoreSearchResult(el),
          }));
        break;
      }
    }

    return results;
  }

  extractPosts(max_items = 20, summarize = true) {
    // Social media post patterns
    const selectors = [
      '[data-testid="tweet"], .tweet, .post',
      'article[role="article"]', // Twitter/X posts
      ".timeline-item, .feed-item",
      ".status, .update, .entry",
    ];

    let posts = [];
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        posts = Array.from(elements)
          .slice(0, max_items)
          .map((el, index) => ({
            index: index + 1,
            text: this.extractPostText(el, summarize),
            author: this.extractPostAuthor(el),
            timestamp: this.extractPostTimestamp(el),
            metrics: this.extractPostMetrics(el),
            has_media: this.hasPostMedia(el),
            post_type: this.detectPostType(el),
          }));
        break;
      }
    }

    return posts;
  }

  // Content summarization methods
  summarizeContent(content, content_type) {
    switch (content_type) {
      case "article":
        return this.summarizeArticle(content);
      case "search_results":
        return this.summarizeSearchResults(content);
      case "posts":
        return this.summarizePosts(content);
      default:
        return { summary: "Unknown content type" };
    }
  }

  summarizeArticle(content) {
    return {
      title: content.title || "Untitled",
      word_count: content.word_count || 0,
      reading_time: Math.ceil((content.word_count || 0) / 200),
      has_images: document.querySelectorAll("img").length > 0,
      has_videos:
        document.querySelectorAll(
          'video, iframe[src*="youtube"], iframe[src*="vimeo"]'
        ).length > 0,
      preview:
        content.content?.substring(0, 200) +
        (content.content?.length > 200 ? "..." : ""),
      estimated_tokens: Math.ceil((content.content?.length || 0) / 4),
    };
  }

  summarizeSearchResults(results) {
    const domains = results
      .map((r) => r.link)
      .filter(Boolean)
      .map((url) => {
        try {
          return new URL(url).hostname;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return {
      total_results: results.length,
      result_types: [...new Set(results.map((r) => r.type))],
      top_domains: this.getTopDomains(domains),
      avg_score: results.length
        ? results.reduce((sum, r) => sum + (r.score || 0), 0) / results.length
        : 0,
      has_sponsored: results.some((r) => r.type === "sponsored"),
      quality_score: this.calculateQualityScore(results),
    };
  }

  summarizePosts(posts) {
    const totalTextLength = posts.reduce(
      (sum, p) => sum + (p.text?.length || 0),
      0
    );
    const totalLikes = posts.reduce(
      (sum, p) => sum + (p.metrics?.likes || 0),
      0
    );

    return {
      post_count: posts.length,
      avg_length: posts.length ? Math.round(totalTextLength / posts.length) : 0,
      has_media_count: posts.filter((p) => p.has_media).length,
      engagement_total: totalLikes,
      avg_engagement: posts.length ? Math.round(totalLikes / posts.length) : 0,
      post_types: [...new Set(posts.map((p) => p.post_type))],
      authors: [...new Set(posts.map((p) => p.author).filter(Boolean))].length,
      estimated_tokens: Math.ceil(totalTextLength / 4),
    };
  }

  // Helper methods for extraction
  extractResultTitle(element, summarize = true) {
    const titleSelectors = [
      'h1, h2, h3, .title, .headline, [data-testid*="title"]',
    ];
    for (const selector of titleSelectors) {
      const title = readableText(element.querySelector(selector));
      if (title) {
        return summarize ? title.substring(0, 100) : title;
      }
    }
    const fallbackTitle = readableText(element) || "No title";
    return summarize ? fallbackTitle.substring(0, 50) : fallbackTitle;
  }

  extractResultSummary(element, summarize = true) {
    const summarySelectors = [".summary, .description, .snippet, .excerpt"];
    for (const selector of summarySelectors) {
      const summary = readableText(element.querySelector(selector));
      if (summary) {
        return summarize ? summary.substring(0, 200) : summary;
      }
    }
    const fallbackSummary = readableText(element);
    return summarize ? fallbackSummary.substring(0, 150) : fallbackSummary;
  }

  extractResultLink(element) {
    const link =
      element.querySelector("a[href]")?.href ||
      element.closest("a[href]")?.href ||
      element.getAttribute("href");
    return link || null;
  }

  detectResultType(element) {
    if (
      element.textContent?.toLowerCase().includes("sponsored") ||
      element.querySelector(".ad, .sponsored")
    )
      return "sponsored";
    if (element.querySelector("img, video")) return "media";
    if (element.querySelector(".price, .cost")) return "product";
    return "organic";
  }

  scoreSearchResult(element) {
    let score = 0.5;
    if (element.querySelector("h1, h2, h3")) score += 0.2;
    if (element.querySelector("img")) score += 0.1;
    if (element.textContent?.length > 100) score += 0.1;
    if (element.querySelector("a[href]")) score += 0.1;
    return Math.min(score, 1.0);
  }

  extractPostText(element, summarize = true) {
    const textSelectors = [
      '[data-testid="tweetText"], .tweet-text',
      ".post-content, .entry-content",
      ".status-content, .message-content",
    ];

    for (const selector of textSelectors) {
      const text = readableText(element.querySelector(selector));
      if (text) {
        return summarize ? text.substring(0, 280) : text;
      }
    }

    const fallbackText = readableText(element);
    return summarize ? fallbackText.substring(0, 280) : fallbackText;
  }

  extractPostAuthor(element) {
    const authorSelectors = [
      '[data-testid="User-Name"], .username',
      ".author, .user-name, .handle",
    ];

    for (const selector of authorSelectors) {
      const author = element.querySelector(selector)?.textContent?.trim();
      if (author) return author.substring(0, 50);
    }
    return "Unknown";
  }

  extractPostTimestamp(element) {
    const timeSelectors = ['time, .timestamp, .date, [data-testid*="time"]'];
    for (const selector of timeSelectors) {
      const time = element.querySelector(selector);
      if (time) {
        return (
          time.getAttribute("datetime") || time.textContent?.trim() || null
        );
      }
    }
    return null;
  }

  extractPostMetrics(element) {
    const metrics = {};
    const likeSelectors = ['[data-testid*="like"], .like-count, .heart-count'];
    const replySelectors = [
      '[data-testid*="reply"], .reply-count, .comment-count',
    ];
    const shareSelectors = [
      '[data-testid*="retweet"], .share-count, .repost-count',
    ];

    for (const selector of likeSelectors) {
      const likes = element
        .querySelector(selector)
        ?.textContent?.match(/\d+/)?.[0];
      if (likes) metrics.likes = parseInt(likes);
    }

    for (const selector of replySelectors) {
      const replies = element
        .querySelector(selector)
        ?.textContent?.match(/\d+/)?.[0];
      if (replies) metrics.replies = parseInt(replies);
    }

    for (const selector of shareSelectors) {
      const shares = element
        .querySelector(selector)
        ?.textContent?.match(/\d+/)?.[0];
      if (shares) metrics.shares = parseInt(shares);
    }

    return metrics;
  }

  hasPostMedia(element) {
    return element.querySelector('img, video, [data-testid*="media"]') !== null;
  }

  detectPostType(element) {
    if (element.querySelector('[data-testid*="retweet"]')) return "repost";
    if (element.querySelector('[data-testid*="reply"]')) return "reply";
    if (element.hasAttribute("data-promoted")) return "promoted";
    return "original";
  }

  getTopDomains(domains, limit = 5) {
    const domainCounts = {};
    domains.forEach((domain) => {
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    });

    return Object.entries(domainCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([domain, count]) => ({ domain, count }));
  }

  calculateQualityScore(results) {
    // An extractor that matched nothing returns [], which would make every
    // term NaN and ship "NaN%" to the model.
    if (results.length === 0) return 0;

    const avgScore =
      results.reduce((sum, r) => sum + (r.score || 0), 0) / results.length;
    const hasLinks = results.filter((r) => r.link).length / results.length;
    const hasContent =
      results.filter((r) => r.summary?.length > 50).length / results.length;

    return Math.round(
      (avgScore * 0.4 + hasLinks * 0.3 + hasContent * 0.3) * 100
    );
  }

  getExtractionMethod(content_type) {
    const hostname = window.location.hostname;
    if (hostname.includes("twitter") || hostname.includes("x.com"))
      return "twitter_patterns";
    if (hostname.includes("github")) return "github_patterns";
    if (hostname.includes("google")) return "google_patterns";
    return `semantic_${content_type}`;
  }

  estimateContentTokens(content) {
    if (Array.isArray(content)) {
      return content.reduce((sum, item) => {
        return sum + Math.ceil(JSON.stringify(item).length / 4);
      }, 0);
    } else {
      return Math.ceil(JSON.stringify(content).length / 4);
    }
  }

  async clickElement({ element_id, click_type = "left", wait_after = 1000 }) {
    const element = this.getElementById(element_id);
    if (!element) {
      throw new Error(`Element not found: ${element_id}`);
    }

    if (click_type !== "right" &&
        (element.matches('input[type="file"]') || element.control?.matches('input[type="file"]'))) {
      throw new Error(FILE_PICKER_INSTRUCTIONS);
    }
    if (element.tagName === "OPTION") {
      const select = element.closest("select");
      if (click_type !== "left") throw new Error("Для выбора варианта используйте левый клик.");
      if (!nativeOptionIsShown(element) || !nativeOptionIsEnabled(element) || this.isElementDisabled(select)) {
        throw new Error("Вариант выпадающего списка недоступен.");
      }
      select.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
      select.focus({ preventScroll: true });
      this.selectNativeOption(select, element);
      await settle(Number(wait_after) || 0);
      if (select.selectedIndex !== element.index) throw new Error("Вариант выпадающего списка не сохранился.");
      return { success: true, element_id, click_type, element_name: element.label };
    }

    // claude-for-arc: a disabled control ignores clicks; say so instead of
    // reporting a success that did nothing.
    if (this.isElementDisabled(element)) {
      throw new Error(`Элемент «${this.getElementName(element)}» выключен (disabled) — клик ничего не сделает`);
    }

    element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });

    // Send exactly what one real mouse click produces. Widgets (menus, and
    // press handlers like React Aria's) act on pointer events and then skip
    // the click that follows; a click with detail 0 (element.click()) or
    // pointer events without pointerType look like a second, keyboard press,
    // and a send button then sends twice.
    const rect = element.getBoundingClientRect();
    const button = click_type === "right" ? 2 : 0;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button,
    };
    const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1 };
    const press = (detail) => {
      element.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 << (button === 2 ? 1 : 0), pressure: 0.5 }));
      element.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 << (button === 2 ? 1 : 0), detail }));
      if (typeof element.focus === "function" && button === 0) element.focus({ preventScroll: true });
      element.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0, pressure: 0 }));
      element.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0, detail }));
    };

    element.dispatchEvent(new PointerEvent("pointerover", pointer));
    element.dispatchEvent(new MouseEvent("mouseover", base));
    if (click_type === "right") {
      press(1);
      element.dispatchEvent(new MouseEvent("contextmenu", { ...base, detail: 1 }));
    } else {
      press(1);
      element.dispatchEvent(new MouseEvent("click", { ...base, detail: 1 }));
      if (click_type === "double") {
        press(2);
        element.dispatchEvent(new MouseEvent("click", { ...base, detail: 2 }));
        element.dispatchEvent(new MouseEvent("dblclick", { ...base, detail: 2 }));
      }
    }

    // Wait until the page stops changing (or wait_after ms at most) instead
    // of a fixed pause.
    await settle(Number(wait_after) || 0);

    return {
      success: true,
      element_id,
      click_type,
      element_name: this.getElementName(element),
    };
  }

  async ensureProperFocus(element) {
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });

    // Simulate proper mouse interaction sequence
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Fire mouse events in sequence
    element.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        clientX: centerX,
        clientY: centerY,
      })
    );

    element.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: centerX,
        clientY: centerY,
      })
    );

    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: centerX,
        clientY: centerY,
      })
    );

    // Focus and fire focus events
    element.focus();
    element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("focus", { bubbles: true }));

    // Let the framework attach its handlers.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async clearElementContent(element) {
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      const proto = element.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(element, "");
      else element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (element.contentEditable === "true") {
      // For contenteditable, simulate selecting all and deleting
      element.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  async fillWithEvents(element, value) {
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      // React and similar libraries track the value through the prototype's
      // setter; assigning element.value directly leaves their state stale.
      const proto = element.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event("beforeinput", { bubbles: true }));
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));

      // Fire keyboard events to simulate typing completion
      element.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "End" })
      );
      element.dispatchEvent(
        new KeyboardEvent("keyup", { bubbles: true, key: "End" })
      );
    } else if (element.contentEditable === "true") {
      // For contenteditable elements (like Twitter)
      element.textContent = value;
      element.dispatchEvent(new Event("beforeinput", { bubbles: true }));
      element.dispatchEvent(new Event("input", { bubbles: true }));

      // Trigger composition events for better compatibility
      element.dispatchEvent(
        new CompositionEvent("compositionend", {
          bubbles: true,
          data: value,
        })
      );

      // Fire selection change to notify frameworks
      document.dispatchEvent(new Event("selectionchange"));
    }

    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  getElementValue(element) {
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT") {
      return element.value;
    } else if (element.contentEditable === "true") {
      return element.textContent || element.innerText || "";
    }
    return "";
  }

  // Element state detection methods
  getElementState(element) {
    const state = {
      disabled: this.isElementDisabled(element),
      visible: this.isLikelyVisible(element),
      clickable: this.isElementClickable(element),
      focusable: this.isElementFocusable(element),
      hasText: this.hasText(element),
      isEmpty: this.isEmpty(element),
    };

    // Overall interaction readiness
    state.interaction_ready =
      state.visible && !state.disabled && (state.clickable || state.focusable);

    return state;
  }

  isElementDisabled(element) {
    // Check disabled attribute
    if (element.disabled === true) return true;
    if (element.getAttribute("disabled") !== null) return true;

    // Check aria-disabled
    if (element.getAttribute("aria-disabled") === "true") return true;

    // Check common disabled classes
    const disabledClasses = [
      "disabled",
      "btn-disabled",
      "button-disabled",
      "inactive",
    ];
    const classList = Array.from(element.classList);
    if (disabledClasses.some((cls) => classList.includes(cls))) return true;

    // Check if parent form/fieldset is disabled
    const parentFieldset = element.closest("fieldset[disabled]");
    if (parentFieldset) return true;

    // Check computed styles for pointer-events: none
    const computedStyle = getComputedStyle(element);
    if (computedStyle.pointerEvents === "none") return true;

    return false;
  }

  isElementClickable(element) {
    const clickableTags = ["BUTTON", "A", "INPUT"];
    const clickableTypes = ["button", "submit", "reset"];
    const clickableRoles = ["button", "link", "menuitem", "tab"];

    // Check tag and type
    if (clickableTags.includes(element.tagName)) return true;
    if (element.type && clickableTypes.includes(element.type)) return true;

    // Check role
    const role = element.getAttribute("role");
    if (role && clickableRoles.includes(role)) return true;

    // Check for click handlers
    if (element.onclick || element.getAttribute("onclick")) return true;

    // Check for common clickable classes
    const clickableClasses = ["btn", "button", "clickable", "link"];
    const classList = Array.from(element.classList);
    if (clickableClasses.some((cls) => classList.includes(cls))) return true;

    return false;
  }

  isElementFocusable(element) {
    const focusableTags = ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"];

    // Check if element is naturally focusable
    if (focusableTags.includes(element.tagName)) return true;

    // Check tabindex
    const tabindex = element.getAttribute("tabindex");
    if (tabindex && tabindex !== "-1") return true;

    // Check contenteditable
    if (element.contentEditable === "true") return true;

    // Check role
    const focusableRoles = ["textbox", "searchbox", "button", "link"];
    const role = element.getAttribute("role");
    if (role && focusableRoles.includes(role)) return true;

    return false;
  }

  hasText(element) {
    const text =
      element.textContent ||
      element.value ||
      element.getAttribute("aria-label") ||
      "";
    return text.trim().length > 0;
  }

  isEmpty(element) {
    if (element.tagName === "SELECT") return element.selectedIndex < 0;
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      return !element.value || element.value.trim().length === 0;
    }
    if (element.contentEditable === "true") {
      return !element.textContent || element.textContent.trim().length === 0;
    }
    return false;
  }

  async waitForCondition({ condition_type, selector, text, timeout = 5000 }) {
    const startTime = Date.now();

    const conditions = {
      element_visible: () => {
        const el = document.querySelector(selector);
        return el && el.offsetParent !== null;
      },
      text_present: () => document.body.textContent.includes(text),
    };

    const checkCondition = conditions[condition_type];
    if (!checkCondition) {
      throw new Error(`Unknown condition type: ${condition_type}`);
    }

    while (Date.now() - startTime < timeout) {
      if (checkCondition()) {
        return {
          condition_met: true,
          condition_type: condition_type,
          wait_time: Date.now() - startTime,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for condition: ${condition_type}`);
  }

  // Utility methods
  // claude-for-arc: find the element an action names by selector, visible
  // text (buttons, links) or label / placeholder (fields). Prefers visible,
  // better-matching and smaller (more specific) elements.
  findTarget({ selector, text, label, index = 0 }, action) {
    let candidates;
    let describe;
    if (selector) {
      describe = `selector «${selector}»`;
      try {
        candidates = [...document.querySelectorAll(selector)].filter(element =>
          action === "element_click" && element.tagName === "OPTION" ? nativeOptionIsShown(element) : isShown(element)
        );
      } catch (error) {
        throw new Error(`Неверный CSS-селектор «${selector}»: ${error.message}`);
      }
    } else {
      const wantField = action === "element_fill" || (label && !text);
      const wanted = norm(text || label);
      describe = wantField ? `поле «${text || label}»` : `элемент «${text || label}»`;
      const pool = [...document.querySelectorAll(wantField ? FIELDS : CLICKABLE)].filter(isShown);
      const scored = pool
        .map((el) => ({ el, score: matchScore(wantField ? fieldNames(el) : clickableNames(el), wanted) }))
        .filter((c) => c.score > 0);
      if (!scored.length && !wantField) {
        // Clickable things without a role (a styled div): the smallest element
        // showing exactly that text, or its nearest clickable-looking ancestor.
        for (const el of document.body.querySelectorAll("*")) {
          if (el.children.length > 3 || norm(el.innerText) !== wanted || !isShown(el)) continue;
          let target = el;
          for (let up = el; up && up !== document.body; up = up.parentElement) {
            if (up.matches(CLICKABLE) || getComputedStyle(up).cursor === "pointer") { target = up; break; }
          }
          scored.push({ el: target, score: 1 });
        }
      }
      scored.sort((a, b) => b.score - a.score || (a.el.innerText || "").length - (b.el.innerText || "").length);
      candidates = [...new Set(scored.map((c) => c.el))];
    }
    const found = candidates[Number(index) || 0];
    if (!found) {
      throw new Error(`Не нашёл ${describe} на странице${candidates.length ? ` (совпадений: ${candidates.length}, index ${index})` : ""}. Уточните текст или вызовите page_analyze.`);
    }
    return found;
  }

  // claude-for-arc: one key press on the given element or the focused one.
  async pressKey({ element_id, key = "Enter", modifiers = [], wait_after = 1000 }) {
    const KEYS = {
      Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9], Backspace: ["Backspace", 8],
      Delete: ["Delete", 46], " ": ["Space", 32], ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40],
      ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39], Home: ["Home", 36], End: ["End", 35],
      PageUp: ["PageUp", 33], PageDown: ["PageDown", 34],
    };
    const name = key === "Space" ? " " : key === "Esc" ? "Escape" : key;
    const single = name.length === 1;
    if (!KEYS[name] && !single) throw new Error(`Клавиша «${key}» не поддерживается`);
    const [code, keyCode] = KEYS[name] || [`Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
    let target = element_id ? this.getElementById(element_id) : document.activeElement;
    if (element_id && !target) throw new Error(`Element not found: ${element_id}`);
    if (!target || target === document.documentElement) target = document.body;
    if ((name === "Enter" || name === " ") && target.matches('input[type="file"]')) {
      throw new Error(FILE_PICKER_INSTRUCTIONS);
    }
    if (element_id && typeof target.focus === "function") target.focus({ preventScroll: true });
    const mods = new Set((Array.isArray(modifiers) ? modifiers : [modifiers]).map((m) => String(m).toLowerCase()));
    const init = {
      key: name, code, bubbles: true, cancelable: true, composed: true, view: window,
      ctrlKey: mods.has("ctrl") || mods.has("control"), metaKey: mods.has("meta") || mods.has("cmd"),
      shiftKey: mods.has("shift"), altKey: mods.has("alt") || mods.has("option"),
    };
    const fire = (type) => {
      const event = new KeyboardEvent(type, init);
      // Older handlers read keyCode / which, which an init dict cannot set.
      Object.defineProperty(event, "keyCode", { get: () => keyCode });
      Object.defineProperty(event, "which", { get: () => keyCode });
      return target.dispatchEvent(event);
    };
    const previousIndex = target.selectedIndex;
    const notPrevented = fire("keydown");
    if (notPrevented && (name === "Enter" || single)) fire("keypress");
    if (notPrevented && mods.size === 0 && target.tagName === "SELECT" && !target.multiple &&
        (name === "ArrowDown" || name === "ArrowUp") && target.selectedIndex === previousIndex &&
        !this.isElementDisabled(target)) {
      const options = [...target.options];
      const next = name === "ArrowDown"
        ? options.slice(previousIndex + 1)
        : options.slice(0, previousIndex < 0 ? options.length : previousIndex).reverse();
      const option = next.find(item => nativeOptionIsEnabled(item) && nativeOptionIsShown(item));
      if (option) this.selectNativeOption(target, option);
    }
    fire("keyup");
    // A real Enter in a single-line field submits its form; a synthetic one
    // does not, so do it here unless the page handled the key itself.
    let submitted = false;
    if (notPrevented && name === "Enter" && target.tagName === "INPUT" && target.form) {
      target.form.requestSubmit();
      submitted = true;
    }
    await settle(Number(wait_after) || 0);
    return {
      success: true,
      key: name,
      element_id: element_id || null,
      element_name: this.getElementName(target),
      handled_by_page: !notPrevented,
      form_submitted: submitted,
    };
  }

  registerElement(element) {
    const id = `element_${++this.idCounter}`;
    this.elementRegistry.set(id, element);
    return id;
  }

  // Runs at the start of every analyze call. Drops ids whose node the page
  // removed, then the oldest past the cap. Live ids from earlier calls keep
  // working, so "discover username, discover password, fill the first" holds.
  pruneRegistries() {
    for (const registry of [this.elementRegistry, this.quickRegistry]) {
      for (const [id, element] of registry) {
        if (!element.isConnected) registry.delete(id);
      }
      // a Map iterates in insertion order, so this evicts the oldest first
      for (const id of registry.keys()) {
        if (registry.size <= MAX_REGISTRY_ENTRIES) break;
        registry.delete(id);
      }
    }
  }

  getElementById(id) {
    // Check quick registry first (for q1, q2, etc.)
    const element = id.startsWith("q")
      ? this.quickRegistry.get(id)
      // Then check main registry (for element_1, element_2, etc.)
      : this.elementRegistry.get(id);
    // A client-side route change (content scripts persist across it, unlike a
    // full page load) can leave a registered id pointing at a node the page
    // itself already removed. Treat that the same as a cache miss rather than
    // handing a detached node back to a caller expecting a live element.
    if (element && !element.isConnected) {
      return undefined;
    }
    return element;
  }

  getElementName(element) {
    if (element.tagName === "SELECT") {
      const name = fieldNames(element).find(candidate => candidate?.trim());
      return name ? name.replace(/\s+/g, " ").trim() : "select";
    }
    return (
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.textContent?.trim()?.substring(0, 50) ||
      element.placeholder ||
      element.tagName.toLowerCase()
    );
  }


  generateSelector(element) {
    if (element.id) return `#${element.id}`;
    if (element.getAttribute("data-testid"))
      return `[data-testid="${element.getAttribute("data-testid")}"]`;

    let selector = element.tagName.toLowerCase();
    if (element.className) {
      selector += `.${element.className.split(" ").join(".")}`;
    }
    return selector;
  }

  inferElementType(element, intentHint) {
    const tagName = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const type = element.getAttribute("type");

    if (tagName === "input" && type === "search") return "search_input";
    if (tagName === "input") return "input";
    if (tagName === "textarea") return "textarea";
    if (tagName === "button" || role === "button") return "button";
    if (tagName === "a") return "link";

    return "element";
  }

  // claude-for-arc: score by how many words of the hint the element mentions
  // (name, placeholder, label, id) plus whether its kind matches words like
  // "кнопка"/"button" or "ссылка"/"link". Upstream only matched the whole hint
  // as one substring, so multi-word hints left every element tied at 0.5.
  calculateConfidence(element, intentHint) {
    const hint = String(intentHint || "").toLowerCase();
    const words = hint.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
    const kind = this.elementKind(element);
    const typeWords = {
      button: ["button", "кнопк", "click", "нажм", "нажат", "submit", "отправ", "press"],
      link: ["link", "ссылк", "navigation", "nav", "перейти", "url"],
      input: ["input", "field", "поле", "поля", "fill", "заполн", "form", "форм", "search", "поиск", "textbox", "type", "ввод", "введ"],
    };
    const isTypeWord = (w) => Object.values(typeWords).some((list) => list.some((t) => w.startsWith(t)));
    const contentWords = words.filter((w) => !isTypeWord(w));

    const haystack = [
      this.getElementName(element),
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("name"),
      element.id,
      element.getAttribute("href"),
    ].filter(Boolean).join(" ").toLowerCase();

    let confidence = 0.3;
    if (contentWords.length) {
      const matched = contentWords.filter((w) => haystack.includes(w)).length;
      confidence += 0.5 * (matched / contentWords.length);
    }
    if (kind && words.some((w) => typeWords[kind].some((t) => w.startsWith(t)))) confidence += 0.2;
    if (hint && haystack.includes(hint)) confidence += 0.1;
    if (element.getAttribute("data-testid")) confidence += 0.05;
    if (element.disabled) confidence -= 0.2;
    return Math.max(0, Math.min(confidence, 1.0));
  }

  elementKind(element) {
    const tag = element.tagName;
    const role = element.getAttribute("role");
    const type = (element.getAttribute("type") || "").toLowerCase();
    if (tag === "BUTTON" || role === "button" || (tag === "INPUT" && ["submit", "button", "reset"].includes(type))) return "button";
    if (tag === "A" || role === "link") return "link";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable || role === "textbox" || role === "searchbox") return "input";
    return null;
  }

  // Two-phase utility methods
  compressElement(element, isQuick = false) {
    const actualElement = element.element || element;
    const state = this.getElementState(actualElement);

    if (isQuick) {
      // Quick phase - minimal data with state
      const quickId = `q${++this.quickIdCounter}`;
      this.quickRegistry.set(quickId, actualElement);

      return {
        id: quickId,
        type: element.type || "element",
        name: element.name?.substring(0, 20) || "unnamed",
        conf: Math.round((element.confidence || 0.5) * 100),
        selector: element.selector || "unknown",
        state: state.disabled ? "disabled" : "enabled",
        clickable: state.clickable,
        ready: state.interaction_ready,
      };
    } else {
      // Detailed phase - compact fingerprint with full state
      return {
        id: element.id,
        fp: this.generateFingerprint(actualElement),
        name: element.name?.substring(0, 30) || "unnamed",
        conf: Math.round((element.confidence || 0.5) * 100),
        meta: {
          ...this.getElementMeta(actualElement),
          state: state,
        },
      };
    }
  }

  generateFingerprint(element) {
    const tag = element.tagName.toLowerCase();
    const primaryClass = this.getPrimaryClass(element);
    const context = this.getContext(element);
    const position = this.getRelativePosition(element);

    return `${tag}${
      primaryClass ? "." + primaryClass : ""
    }@${context}.${position}`;
  }

  getPrimaryClass(element) {
    const importantClasses = [
      "btn",
      "button",
      "link",
      "input",
      "search",
      "submit",
      "primary",
      "secondary",
    ];
    const classList = Array.from(element.classList);
    return (
      classList.find((cls) => importantClasses.includes(cls)) || classList[0]
    );
  }

  getContext(element) {
    const parent =
      element.closest("nav, main, header, footer, form, section, article") ||
      element.parentElement;
    if (!parent) return "body";
    return parent.tagName.toLowerCase();
  }

  getRelativePosition(element) {
    const siblings = Array.from(element.parentElement?.children || []);
    const sameTypeElements = siblings.filter(
      (el) => el.tagName === element.tagName
    );
    return sameTypeElements.indexOf(element) + 1;
  }

  getElementMeta(element) {
    const rect = element.getBoundingClientRect();
    return {
      rect: [
        Math.round(rect.x),
        Math.round(rect.y),
        Math.round(rect.width),
        Math.round(rect.height),
      ],
      visible: this.isLikelyVisible(element),
      form_context: element.closest("form") ? "form" : null,
    };
  }

  detectPageType() {
    const hostname = window.location.hostname;
    const title = document.title.toLowerCase();
    const hasSearch = document.querySelector(
      '[type="search"], [role="searchbox"]'
    );
    const hasLogin = document.querySelector(
      '[type="password"], [name*="login" i]'
    );
    const hasPost = document.querySelector(
      '[contenteditable="true"], textarea[placeholder*="post" i]'
    );

    if (hostname.includes("twitter") || hostname.includes("x.com"))
      return "social_media";
    if (hostname.includes("github")) return "code_repository";
    if (hostname.includes("google")) return "search_engine";
    if (hasPost) return "content_creation";
    if (hasLogin) return "authentication";
    if (hasSearch) return "search_interface";
    if (title.includes("shop") || title.includes("store")) return "ecommerce";

    return "general_website";
  }

  countViewportElements() {
    const elements = document.querySelectorAll(
      "button, input, select, textarea, a[href]"
    );
    const viewportElements = Array.from(elements).filter((el) =>
      this.isLikelyVisible(el)
    );

    return {
      buttons: viewportElements.filter(
        (el) => el.tagName === "BUTTON" || el.getAttribute("role") === "button"
      ).length,
      inputs: viewportElements.filter((el) => el.tagName === "INPUT").length,
      links: viewportElements.filter((el) => el.tagName === "A").length,
      textareas: viewportElements.filter((el) => el.tagName === "TEXTAREA")
        .length,
      selects: viewportElements.filter((el) => el.tagName === "SELECT").length,
    };
  }

  async quickViewportScan(intent_hint, maxResults = 3) {
    const candidates = document.querySelectorAll(
      'button, input, a[href], [role="button"], textarea'
    );
    const visibleElements = Array.from(candidates)
      .filter((el) => this.isLikelyVisible(el))
      .slice(0, 300); // claude-for-arc: was the first 10 visible elements

    const scoredElements = visibleElements.map((element) => {
      const confidence = this.calculateConfidence(element, intent_hint);
      return {
        element,
        type: this.inferElementType(element, intent_hint),
        name: this.getElementName(element),
        confidence,
      };
    });

    return scoredElements
      .filter((el) => el.confidence > 0.3)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxResults)
      .map((el) => this.compressElement(el, true));
  }

  scoreIntentMatch(intent_hint, quickMatches) {
    if (quickMatches.length === 0) return "none";
    const avgConfidence =
      quickMatches.reduce((sum, match) => sum + match.conf, 0) /
      quickMatches.length;

    if (avgConfidence >= 80) return "high";
    if (avgConfidence >= 60) return "medium";
    if (avgConfidence >= 40) return "low";
    return "none";
  }

  suggestPhase2Areas(quickMatches, intent_hint) {
    const suggestions = [];
    const elementTypes = [...new Set(quickMatches.map((m) => m.type))];

    if (elementTypes.includes("button")) suggestions.push("buttons");
    if (elementTypes.includes("input") || elementTypes.includes("textarea"))
      suggestions.push("forms");
    if (elementTypes.includes("link")) suggestions.push("navigation");

    // Intent-based suggestions
    if (
      intent_hint.toLowerCase().includes("search") &&
      !suggestions.includes("forms")
    ) {
      suggestions.push("search_elements");
    }

    return suggestions.slice(0, 3);
  }

  estimatePhase2Tokens(quickMatches) {
    // Estimate tokens needed for detailed analysis
    const baseTokens = 50; // Base overhead
    const tokensPerElement = 15; // Detailed element info
    const contextTokens = 20; // Page context

    return baseTokens + quickMatches.length * tokensPerElement + contextTokens;
  }

  async expandQuickMatches(element_ids) {
    const elements = [];
    for (const id of element_ids) {
      const element = this.quickRegistry.get(id);
      if (element) {
        const elementId = this.registerElement(element);
        elements.push({
          id: elementId,
          type: this.inferElementType(element, ""),
          name: this.getElementName(element),
          confidence: 0.8, // Default confidence for expanded elements
          element: element,
        });
      }
    }
    return elements;
  }

  async analyzeFocusAreas(focus_areas, intent_hint) {
    const elements = [];
    const areaSelectors = {
      buttons: 'button, [role="button"], input[type="submit"]',
      forms: 'input, textarea, select, [contenteditable="true"]',
      navigation: 'nav a, .nav-item, [role="navigation"] a',
      search_elements:
        '[type="search"], [role="searchbox"], [placeholder*="search" i]',
    };

    for (const area of focus_areas) {
      const selector = areaSelectors[area];
      if (selector) {
        const areaElements = document.querySelectorAll(selector);
        for (const element of Array.from(areaElements).slice(0, 5)) {
          if (this.isLikelyVisible(element)) {
            const elementId = this.registerElement(element);
            elements.push({
              id: elementId,
              type: this.inferElementType(element, intent_hint),
              name: this.getElementName(element),
              confidence: this.calculateConfidence(element, intent_hint),
              element: element,
            });
          }
        }
      }
    }

    return elements;
  }

  async fullEnhancedAnalysis(intent_hint, max_results) {
    const relevantElements = document.querySelectorAll(`
      button, input, select, textarea, a[href],
      [role="button"], [role="textbox"], [role="searchbox"],
      [aria-label], [data-testid], [contenteditable="true"]
    `);

    const elements = Array.from(relevantElements)
      .filter((el) => this.isLikelyVisible(el))
      .slice(0, 600) // claude-for-arc: whole page, not just the first 30
      .map((element) => {
        const elementId = this.registerElement(element);
        return {
          id: elementId,
          type: this.inferElementType(element, intent_hint),
          selector: this.generateSelector(element),
          name: this.getElementName(element),
          confidence: this.calculateConfidence(element, intent_hint),
          element: element,
        };
      })
      .filter((el) => el.confidence > 0.2) // Lower threshold for detailed analysis
      .sort((a, b) => b.confidence - a.confidence);

    return elements.slice(0, max_results);
  }

  deduplicateElements(elements) {
    const seen = new Set();
    return elements.filter((element) => {
      const key = element.name + element.type;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async enhanceElementMetadata(elements) {
    return elements.map((element) => ({
      ...element,
      meta: this.getElementMeta(element.element),
    }));
  }

  isLikelyVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0 &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      style.display !== "none"
    );
  }

  // Get all links on the page with filtering options
  async getPageLinks(options = {}) {
    const {
      include_internal = true,
      include_external = true,
      domain_filter = null,
      max_results = 100
    } = options;

    const links = Array.from(document.querySelectorAll('a[href]'));
    const currentDomain = this.extractDomain(window.location.href);
    const results = [];

    for (const link of links) {
      if (results.length >= max_results) break;

      const href = link.href;
      const linkDomain = this.extractDomain(href);
      const isInternal = this.isSameDomain(currentDomain, linkDomain);

      // Apply internal/external filter
      if (!include_internal && isInternal) continue;
      if (!include_external && !isInternal) continue;

      // Apply domain filter
      if (domain_filter && !linkDomain.includes(domain_filter)) continue;

      const linkText = link.textContent?.trim() || '';
      const linkTitle = link.title || '';

      results.push({
        url: href,
        text: linkText,
        title: linkTitle,
        type: isInternal ? 'internal' : 'external',
        domain: linkDomain
      });
    }

    return {
      links: results,
      total_found: links.length,
      returned: results.length,
      current_domain: currentDomain
    };
  }

  // Check if two domains are the same (handles subdomains)
  isSameDomain(domain1, domain2) {
    if (!domain1 || !domain2) return false;
    
    // Remove www. prefix for comparison
    const clean1 = domain1.replace(/^www\./, '');
    const clean2 = domain2.replace(/^www\./, '');
    
    // A subdomain on either side counts as the same site. Match on a dot
    // boundary so notexample.com is not treated as part of example.com.
    return clean1 === clean2 ||
      clean1.endsWith('.' + clean2) ||
      clean2.endsWith('.' + clean1);
  }

  // Extract domain from URL
  extractDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  // Scroll page with comprehensive options
  async scrollPage(options = {}) {
    const {
      direction = 'down',
      amount = 'medium',
      pixels = null,
      smooth = true,
      element_id = null,
      wait_after = 500
    } = options;
    
    const startPosition = {
      x: window.scrollX,
      y: window.scrollY
    };

    try {
      // If element_id is provided, scroll to that element
      if (element_id) {
        const element = this.getElementById(element_id);
        if (!element) {
          throw new Error(`Element not found: ${element_id}`);
        }
        
        element.scrollIntoView({
          behavior: smooth ? 'smooth' : 'instant',
          block: 'center',
          inline: 'center'
        });
        
        await new Promise(resolve => setTimeout(resolve, wait_after));
        
        return {
          success: true,
          previous_position: startPosition,
          new_position: { x: window.scrollX, y: window.scrollY },
          method: 'scroll_to_element',
          element_id: element_id,
          element_name: this.getElementName(element)
        };
      }

      // Calculate scroll amount based on amount parameter
      let scrollAmount;
      if (amount === 'custom' && pixels) {
        scrollAmount = pixels;
      } else {
        switch (amount) {
          case 'small':
            scrollAmount = Math.min(200, window.innerHeight * 0.25);
            break;
          case 'medium':
            scrollAmount = Math.min(2000, window.innerHeight * 2.0);
            break;
          case 'large':
            scrollAmount = Math.min(800, window.innerHeight * 0.8);
            break;
          case 'page':
            scrollAmount = window.innerHeight * 0.9; // Slightly less than full page for overlap
            break;
          default:
            scrollAmount = Math.min(2000, window.innerHeight * 2.0);
        }
      }

      // Calculate scroll direction
      let scrollX = 0;
      let scrollY = 0;
      
      switch (direction) {
        case 'up':
          scrollY = -scrollAmount;
          break;
        case 'down':
          scrollY = scrollAmount;
          break;
        case 'left':
          scrollX = -scrollAmount;
          break;
        case 'right':
          scrollX = scrollAmount;
          break;
        case 'top':
          // Scroll to top of page
          if (smooth) {
            window.scrollTo({ top: 0, left: window.scrollX, behavior: 'smooth' });
          } else {
            window.scrollTo(window.scrollX, 0);
          }
          await new Promise(resolve => setTimeout(resolve, wait_after));
          return {
            success: true,
            previous_position: startPosition,
            new_position: { x: window.scrollX, y: window.scrollY },
            direction: direction,
            method: 'scroll_to_top'
          };
        case 'bottom':
          // Scroll to bottom of page
          const maxY = Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight
          ) - window.innerHeight;
          if (smooth) {
            window.scrollTo({ top: maxY, left: window.scrollX, behavior: 'smooth' });
          } else {
            window.scrollTo(window.scrollX, maxY);
          }
          await new Promise(resolve => setTimeout(resolve, wait_after));
          return {
            success: true,
            previous_position: startPosition,
            new_position: { x: window.scrollX, y: window.scrollY },
            direction: direction,
            method: 'scroll_to_bottom'
          };
        default:
          throw new Error(`Unknown scroll direction: ${direction}`);
      }

      // Perform the scroll
      if (smooth) {
        window.scrollBy({
          left: scrollX,
          top: scrollY,
          behavior: 'smooth'
        });
      } else {
        window.scrollBy(scrollX, scrollY);
      }
      
      // Wait for scroll to complete
      await new Promise(resolve => setTimeout(resolve, wait_after));
      
      const finalPosition = {
        x: window.scrollX,
        y: window.scrollY
      };
      
      const actualScrolled = {
        x: finalPosition.x - startPosition.x,
        y: finalPosition.y - startPosition.y
      };

      return {
        success: true,
        previous_position: startPosition,
        new_position: finalPosition,
        direction: direction,
        amount: amount,
        requested_pixels: scrollAmount,
        actual_scrolled: actualScrolled,
        total_distance: Math.sqrt(actualScrolled.x ** 2 + actualScrolled.y ** 2),
        smooth: smooth,
        wait_after: wait_after
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        previous_position: startPosition,
        new_position: { x: window.scrollX, y: window.scrollY },
        direction: direction,
        amount: amount
      };
    }
  }

  // 🎨 Page Styling System
  async handlePageStyle(data) {
    // intensity and duration default in the tool schema but were destructured
    // without defaults, so effects never auto-removed (applyEffect checks
    // `duration > 0`) and the description rendered "for undefineds".
    const { mode, theme, background, text_color, font, font_size, mood,
      intensity = 'medium', effect, duration = 10, remember } = data;
    
    // Remove existing custom styles
    const existingStyle = document.getElementById('opendia-custom-style');
    if (existingStyle) existingStyle.remove();
    
    let css = '';
    let description = '';
    
    try {
      switch (mode) {
        case 'preset':
          const themeData = THEME_PRESETS[theme];
          if (!themeData) throw new Error(`Unknown theme: ${theme}`);
          css = themeData.css;
          description = `Applied ${themeData.name} theme`;
          break;
          
        case 'custom':
          css = this.buildCustomCSS({ background, text_color, font, font_size });
          description = 'Applied custom styling';
          break;
          
        case 'ai_mood':
          css = this.generateMoodCSS(mood, intensity);
          description = `Applied AI-generated style for mood: "${mood}"`;
          break;
          
        case 'effect':
          css = this.applyEffect(effect, duration);
          description = `Applied ${effect} effect for ${duration}s`;
          break;
          
        case 'reset':
          // CSS already removed above
          description = 'Reset page to original styling';
          break;
          
        default:
          throw new Error(`Unknown styling mode: ${mode}`);
      }
      
      if (css) {
        const styleElement = document.createElement('style');
        styleElement.id = 'opendia-custom-style';
        styleElement.textContent = css;
        document.head.appendChild(styleElement);
      }
      
      // Remember preference if requested
      if (remember && mode !== 'reset') {
        const domain = window.location.hostname;
        chrome.storage.local.set({ [`style_${domain}`]: { mode, theme, css } });
      }
      
      return {
        success: true,
        description,
        applied_css: css.length,
        mode,
        theme: theme || 'custom',
        remember_enabled: remember,
        effect_duration: duration,
        mood,
        intensity
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        mode,
        theme,
        applied_css: 0
      };
    }
  }

  buildCustomCSS({ background, text_color, font, font_size }) {
    let css = '';
    
    if (background || text_color || font || font_size) {
      css += '* { ';
      if (background) css += `background: ${background} !important; `;
      if (text_color) css += `color: ${text_color} !important; `;
      if (font) css += `font-family: ${font} !important; `;
      if (font_size) css += `font-size: ${font_size} !important; `;
      css += '}';
    }
    
    return css;
  }

  generateMoodCSS(mood, intensity) {
    const moodMap = {
      'cozy coffee shop': {
        background: '#2c1810',
        text: '#f4e4bc', 
        accent: '#d4af37',
        font: 'Georgia, serif'
      },
      'energetic': {
        background: 'linear-gradient(45deg, #ff6b35, #f7931e)',
        text: '#ffffff',
        effects: 'animation: energyPulse 1s infinite;'
      },
      'calm ocean': {
        background: 'linear-gradient(to bottom, #87ceeb, #4682b4)',
        text: '#ffffff',
        effects: 'animation: gentleWave 4s ease-in-out infinite;'
      },
      'dark professional': {
        background: '#1a1a1a',
        text: '#e0e0e0',
        accent: '#0066cc'
      },
      'warm sunset': {
        background: 'linear-gradient(to bottom, #ff7e5f, #feb47b)',
        text: '#ffffff'
      }
    };
    
    const style = moodMap[mood.toLowerCase()] || moodMap['cozy coffee shop'];
    return this.buildMoodCSS(style);
  }

  buildMoodCSS(style) {
    let css = `
      body {
        background: ${style.background} !important;
        color: ${style.text} !important;
        ${style.font ? `font-family: ${style.font} !important;` : ''}
      }
      
      * {
        color: ${style.text} !important;
      }
      
      a {
        color: ${style.accent || style.text} !important;
      }
    `;
    
    if (style.effects) {
      css += style.effects;
    }
    
    // Add animation keyframes if needed
    if (style.effects && style.effects.includes('energyPulse')) {
      css += `
        @keyframes energyPulse {
          0%, 100% { filter: hue-rotate(0deg); }
          50% { filter: hue-rotate(180deg); }
        }
      `;
    }
    
    if (style.effects && style.effects.includes('gentleWave')) {
      css += `
        @keyframes gentleWave {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
      `;
    }
    
    return css;
  }

  applyEffect(effect, duration) {
    const effects = {
      matrix_rain: `
        body::after {
          content: ''; 
          position: fixed; 
          top: 0; 
          left: 0; 
          width: 100%; 
          height: 100%;
          background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="10" font-size="8" fill="%2300ff00">0</text><text y="20" font-size="8" fill="%2300ff00">1</text><text y="30" font-size="8" fill="%2300ff00">0</text><text y="40" font-size="8" fill="%2300ff00">1</text></svg>');
          animation: matrixFall 2s linear infinite;
          pointer-events: none; 
          z-index: 9999; 
          opacity: 0.7;
        }
        @keyframes matrixFall { 
          from { transform: translateY(-100px); } 
          to { transform: translateY(100vh); } 
        }
      `,
      floating_particles: `
        body::before {
          content: '✨ 🌟 ⭐ 💫'; 
          position: fixed; 
          top: 0; 
          left: 0; 
          width: 100%; 
          height: 100%;
          animation: floatParticles 6s ease-in-out infinite;
          pointer-events: none; 
          z-index: 9999; 
          font-size: 20px;
        }
        @keyframes floatParticles { 
          0%, 100% { transform: translateY(100vh) rotate(0deg); } 
          50% { transform: translateY(-100px) rotate(180deg); } 
        }
      `,
      cursor_trail: `
        body {
          cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="rgba(255,0,255,0.5)"/></svg>'), auto !important;
        }
      `,
      neon_glow: `
        * {
          text-shadow: 0 0 10px #00ffff, 0 0 20px #00ffff, 0 0 30px #00ffff !important;
        }
        
        a, button {
          box-shadow: 0 0 15px #ff00ff !important;
        }
      `,
      typing_effect: `
        * {
          animation: typewriter 2s steps(40, end) infinite !important;
        }
        @keyframes typewriter {
          from { width: 0; }
          to { width: 100%; }
        }
      `
    };
    
    const css = effects[effect] || '';
    
    // Auto-remove effect after duration
    if (duration && duration > 0) {
      setTimeout(() => {
        const effectStyle = document.getElementById('opendia-custom-style');
        if (effectStyle) effectStyle.remove();
      }, duration * 1000);
    }
    
    return css;
  }
}

// Theme Presets Database
const THEME_PRESETS = {
  "dark_hacker": {
    name: "🖤 Dark Hacker",
    css: `
      * { 
        background: #0a0a0a !important; 
        color: #00ff00 !important; 
        font-family: 'Courier New', monospace !important;
      }
      a { color: #00ffff !important; }
      body::before { 
        content: ''; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="50" font-size="10" fill="%23003300">01010101</text></svg>');
        opacity: 0.1; pointer-events: none; z-index: -1;
      }
    `
  },
  "retro_80s": {
    name: "📼 Retro 80s", 
    css: `
      * { 
        background: linear-gradient(45deg, #ff0080, #8000ff) !important;
        color: #ffffff !important;
        font-family: 'Arial Black', sans-serif !important;
        text-shadow: 2px 2px 4px #000000 !important;
      }
      body { animation: retroPulse 2s infinite; }
      @keyframes retroPulse { 0%, 100% { filter: hue-rotate(0deg); } 50% { filter: hue-rotate(180deg); } }
    `
  },
  "rainbow_party": {
    name: "🌈 Rainbow Party",
    css: `
      body { 
        background: linear-gradient(45deg, red, orange, yellow, green, blue, indigo, violet) !important;
        background-size: 400% 400% !important;
        animation: rainbowShift 3s ease infinite !important;
      }
      @keyframes rainbowShift { 
        0%, 100% { background-position: 0% 50%; } 
        50% { background-position: 100% 50%; } 
      }
      * { color: white !important; text-shadow: 1px 1px 2px black !important; }
    `
  },
  "minimalist_zen": {
    name: "🧘 Minimalist Zen",
    css: `
      * {
        background: #f8f8f8 !important;
        color: #333333 !important;
        font-family: 'Georgia', serif !important;
        line-height: 1.6 !important;
      }
      body { max-width: 800px; margin: 0 auto; padding: 20px; }
    `
  },
  "high_contrast": {
    name: "🔍 High Contrast",
    css: `
      * {
        background: #000000 !important;
        color: #ffffff !important;
        font-family: Arial, sans-serif !important;
        font-weight: bold !important;
      }
      a { color: #ffff00 !important; }
    `
  },
  "cyberpunk": {
    name: "🤖 Cyberpunk",
    css: `
      * {
        background: #0d1117 !important;
        color: #ff006e !important;
        font-family: 'Courier New', monospace !important;
      }
      a { color: #00ffff !important; }
      body {
        background-image: 
          linear-gradient(90deg, transparent 79px, #abced4 79px, #abced4 81px, transparent 81px),
          linear-gradient(#eee .1em, transparent .1em);
        background-size: 81px 1.2em;
      }
    `
  },
  "pastel_dream": {
    name: "🌸 Pastel Dream",
    css: `
      * {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
        color: #2c3e50 !important;
        font-family: 'Comic Sans MS', cursive !important;
      }
      body { filter: sepia(20%) saturate(80%); }
    `
  },
  "newspaper": {
    name: "📰 Newspaper",
    css: `
      * {
        background: #ffffff !important;
        color: #000000 !important;
        font-family: 'Times New Roman', serif !important;
        line-height: 1.4 !important;
      }
      body { 
        column-count: 2; 
        column-gap: 2em; 
        max-width: 1200px; 
        margin: 0 auto; 
        padding: 20px;
      }
    `
  }
};

// Initialize the automation system
const browserAutomation = new BrowserAutomation();

} // End of injection guard
