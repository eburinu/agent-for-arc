// Result formatting and fallback tool schemas, kept verbatim from OpenDia
// (aeonfun/opendia, MIT) so upstream fixes stay easy to port.

// Tool result formatting
// claude-for-arc: the formatters below come from OpenDia and end every reply
// with a JSON block of tool name / timing. Claude re-reads each reply on every
// later step, so that block is dropped, and run_steps gets a compact report.
const METADATA_TAIL = /\s*\{\s*"tool":[^{}]*\}\s*$/;
const READ_TOOLS = new Set([
  "page_analyze", "page_extract_content", "element_get_state", "get_page_links", "tab_list", "get_selected_text",
]);

function formatToolResult(toolName, result) {
  if (toolName === "run_steps") return formatRunSteps(result);
  if (toolName === "press_key") return formatPressKey(result);
  return formatToolResultVerbose(toolName, result).replace(METADATA_TAIL, "");
}

function formatPressKey(result) {
  const on = result.element_name ? ` → ${String(result.element_name).slice(0, 60)}` : "";
  const extra = result.form_submitted ? " (form submitted)" : result.handled_by_page ? " (handled by the page)" : "";
  return `✅ Pressed ${result.key}${on}${extra}`;
}

function formatRunSteps(result) {
  const lines = [];
  for (const step of result.report || []) {
    const head = `${step.ok ? "✓" : "✗"} ${step.index + 1}. ${step.tool} (${(step.ms / 1000).toFixed(1)}s)`;
    if (!step.ok) {
      lines.push(`${head}: ${step.error}`);
      continue;
    }
    if (step.tool === "sleep") {
      lines.push(head);
      continue;
    }
    const text = formatToolResult(step.tool, step.result || {}).trim();
    if (READ_TOOLS.has(step.tool)) lines.push(`${head}\n${text}`);
    else lines.push(`${head}: ${text.split("\n")[0].replace(/^✅\s*/, "")}`);
  }
  const skipped = (result.steps_total || 0) - (result.steps_run || 0);
  const status = result.success
    ? `✅ All ${result.steps_total} steps done`
    : `❌ Stopped: ${lines.filter((l) => l.startsWith("✗")).length} failed${skipped ? `, ${skipped} not run` : ""}`;
  return `${status}${result.tab_id != null ? ` · tab ${result.tab_id}` : ""}\n${lines.join("\n")}`;
}

function formatToolResultVerbose(toolName, result) {
  const metadata = {
    tool: toolName,
    execution_time: result.execution_time || 0,
    timestamp: new Date().toISOString(),
  };

  switch (toolName) {
    case "page_analyze":
      return formatPageAnalyzeResult(result, metadata);

    case "page_extract_content":
      return formatContentExtractionResult(result, metadata);

    case "element_click":
      return formatElementClickResult(result, metadata);

    case "element_fill":
      return formatElementFillResult(result, metadata);

    case "page_navigate":
      return `${result.warning ? `⚠️ ${result.warning}` : `✅ Successfully navigated to: ${
        result.url || "unknown URL"
      }`}\n\n${JSON.stringify(metadata, null, 2)}`;

    case "page_wait_for":
      return (
        `✅ Condition met: ${result.condition_type || "unknown"}\n` +
        `Wait time: ${result.wait_time || 0}ms\n\n${JSON.stringify(
          metadata,
          null,
          2
        )}`
      );

    case "get_history":
      return formatHistoryResult(result, metadata);

    case "get_selected_text":
      return formatSelectedTextResult(result, metadata);

    case "page_scroll":
      return formatScrollResult(result, metadata);

    case "get_page_links":
      return formatLinksResult(result, metadata);

    case "tab_create":
      return formatTabCreateResult(result, metadata);

    case "tab_close":
      return formatTabCloseResult(result, metadata);

    case "tab_list":
      return formatTabListResult(result, metadata);

    case "tab_switch":
      return formatTabSwitchResult(result, metadata);

    case "element_get_state":
      return formatElementStateResult(result, metadata);

    case "page_style":
      return formatPageStyleResult(result, metadata);

    default:
      // Tools without a dedicated formatter (get_bookmarks, add_bookmark)
      return JSON.stringify(result, null, 2);
  }
}

function formatPageAnalyzeResult(result, metadata) {
  if (result.elements && result.elements.length > 0) {
    const platformInfo = result.summary?.anti_detection_platform
      ? `\n🎯 Anti-detection platform detected: ${result.summary.anti_detection_platform}`
      : "";

    const summary =
      `Found ${result.elements.length} relevant elements using ${result.method}:${platformInfo}\n\n` +
      result.elements
        .map((el) => {
          // The discover phase emits type/ready/state at the top level; the
          // detailed phase emits a fingerprint and nests state under meta.
          const ready = el.ready ?? el.meta?.state?.interaction_ready;
          const disabled = el.state === "disabled" || el.meta?.state?.disabled;
          const type = el.type || el.fp || "element";
          const readyStatus = ready ? "✅ Ready" : "⚠️ Not ready";
          const stateInfo = disabled ? " (disabled)" : "";
          return `• ${el.name} (${type}) - Confidence: ${el.conf}% ${readyStatus}${stateInfo}\n  Element ID: ${el.id}`;
        })
        .join("\n\n");
    return `${summary}\n\n${JSON.stringify(metadata, null, 2)}`;
  } else {
    const intentHint = result.intent_hint || "unknown";
    const platformInfo = result.summary?.anti_detection_platform
      ? `\nPlatform: ${result.summary.anti_detection_platform}`
      : "";
    return `No relevant elements found for intent: "${intentHint}"${platformInfo}\n\n${JSON.stringify(
      metadata,
      null,
      2
    )}`;
  }
}

function formatContentExtractionResult(result, metadata) {
  // summarize:true (the default) reports extraction_method; summarize:false reports method.
  const method = result.method || result.extraction_method;
  const contentSummary = `Extracted ${result.content_type} content using ${method}:\n\n`;
  if (result.content) {
    // Check if this is full content extraction (summarize=false) or summary
    // If it's a content object with properties, show full content
    // If it's a string or small content, it's probably summarized
    let preview;
    if (typeof result.content === "string") {
      // String content - likely summarized, keep truncation
      preview = result.content.substring(0, 500) + (result.content.length > 500 ? "..." : "");
    } else if (result.content && typeof result.content === "object") {
      // Object content - check if it's full content extraction
      if (result.content.content && result.content.content.length > 1000) {
        // This looks like full content extraction - don't truncate
        preview = JSON.stringify(result.content, null, 2);
      } else {
        // Smaller content, apply truncation
        preview = JSON.stringify(result.content, null, 2).substring(0, 500);
      }
    } else {
      // Fallback
      preview = JSON.stringify(result.content, null, 2).substring(0, 500);
    }
    
    return `${contentSummary}${preview}\n\n${JSON.stringify(
      metadata,
      null,
      2
    )}`;
  } else if (result.summary) {
    const summaryText = formatContentSummary(
      result.summary,
      result.content_type
    );
    return `${contentSummary}${summaryText}\n\n${JSON.stringify(
      metadata,
      null,
      2
    )}`;
  } else {
    return `${contentSummary}No content found\n\n${JSON.stringify(
      metadata,
      null,
      2
    )}`;
  }
}

function formatContentSummary(summary, contentType) {
  switch (contentType) {
    case "article":
      return (
        `📰 Article: "${summary.title}"\n` +
        `📝 Word count: ${summary.word_count}\n` +
        `⏱️ Reading time: ${summary.reading_time} minutes\n` +
        `🖼️ Has media: ${summary.has_images || summary.has_videos}\n` +
        `Preview: ${summary.preview}`
      );

    case "search_results":
      return (
        `🔍 Search Results Summary:\n` +
        `📊 Total results: ${summary.total_results}\n` +
        `🏆 Quality score: ${summary.quality_score}/100\n` +
        `📈 Average relevance: ${Math.round(summary.avg_score * 100)}%\n` +
        `🌐 Top domains: ${summary.top_domains
          ?.map((d) => d.domain)
          .join(", ")}\n` +
        `📝 Result types: ${summary.result_types?.join(", ")}`
      );

    case "posts":
      return (
        `📱 Social Posts Summary:\n` +
        `📊 Post count: ${summary.post_count}\n` +
        `📝 Average length: ${summary.avg_length} characters\n` +
        `❤️ Total engagement: ${summary.engagement_total}\n` +
        `🖼️ Posts with media: ${summary.has_media_count}\n` +
        `👥 Unique authors: ${summary.authors}\n` +
        `📋 Post types: ${summary.post_types?.join(", ")}`
      );

    default:
      return JSON.stringify(summary, null, 2);
  }
}

function formatElementClickResult(result) {
  const type = result.click_type && result.click_type !== "left" ? ` (${result.click_type})` : "";
  return `✅ Clicked${type}: ${String(result.element_name || result.element_id).slice(0, 60)}`;
}

function formatElementFillResult(result, metadata) {
  const methodEmojis = {
    twitter_direct_bypass: "🐦 Twitter Direct Bypass",
    linkedin_direct_bypass: "💼 LinkedIn Direct Bypass",
    facebook_direct_bypass: "📘 Facebook Direct Bypass",
    generic_direct_bypass: "🎯 Generic Direct Bypass",
    standard_fill: "🔧 Standard Fill",
    anti_detection_bypass: "🛡️ Anti-Detection Bypass",
  };

  const methodDisplay = methodEmojis[result.method] || result.method;
  const successIcon = result.success ? "✅" : "❌";

  const target = String(result.element_name || result.element_id || "").slice(0, 60);
  const shown = String(result.actual_value ?? result.value ?? "");
  const value = shown.length > 60 ? `${shown.slice(0, 60)}…` : shown;
  let fillResult = `${successIcon} ${result.success ? "Filled" : "Fill failed"}: ${target}${result.success ? ` = «${value}»` : ""}${
    result.success ? "" : ` (field shows "${String(result.actual_value || "").slice(0, 80)}")`
  }${methodDisplay && result.method !== "standard_fill" ? ` · ${methodDisplay}` : ""}\n`;

  // Add bypass-specific information
  if (
    result.method?.includes("bypass") &&
    result.execCommand_result !== undefined
  ) {
    fillResult += `🔧 execCommand success: ${result.execCommand_result}\n`;
  }

  if (!result.success && result.method?.includes("bypass")) {
    fillResult += `\n⚠️ Direct bypass failed - page may have enhanced detection. Try refreshing the page.\n`;
  }

  return `${fillResult}\n${JSON.stringify(metadata, null, 2)}`;
}

function formatHistoryResult(result, metadata) {
  if (!result.history_items || result.history_items.length === 0) {
    return `🕒 No history items found matching the criteria\n\n${JSON.stringify(metadata, null, 2)}`;
  }

  const summary = `🕒 Found ${result.history_items.length} history items (${result.metadata.total_found} total matches):\n\n`;
  
  const items = result.history_items.map((item, index) => {
    const visitInfo = `Visits: ${item.visit_count}`;
    const timeInfo = new Date(item.last_visit_time).toLocaleDateString();
    const domainInfo = `[${item.domain}]`;
    
    return `${index + 1}. **${item.title}**\n   ${domainInfo} ${visitInfo} | Last: ${timeInfo}\n   URL: ${item.url}`;
  }).join('\n\n');

  const searchSummary = result.metadata.search_params.keywords ?
    `\n🔍 Search: "${result.metadata.search_params.keywords}"` : '';
  const dateSummary = result.metadata.search_params.date_range ?
    `\n📅 Date range: ${result.metadata.search_params.date_range}` : '';
  const domainSummary = result.metadata.search_params.domains ?
    `\n🌐 Domains: ${result.metadata.search_params.domains.join(', ')}` : '';
  const visitSummary = result.metadata.search_params.min_visit_count > 1 ?
    `\n📊 Min visits: ${result.metadata.search_params.min_visit_count}` : '';

  return `${summary}${items}${searchSummary}${dateSummary}${domainSummary}${visitSummary}\n\n${JSON.stringify(metadata, null, 2)}`;
}

function formatSelectedTextResult(result, metadata) {
  if (!result.has_selection) {
    return `📝 No text selected\n\n${result.message || "No text is currently selected on the page"}\n\n${JSON.stringify(metadata, null, 2)}`;
  }

  const textPreview = result.selected_text.length > 200
    ? result.selected_text.substring(0, 200) + "..."
    : result.selected_text;

  let summary = `📝 Selected Text (${result.character_count} characters):\n\n"${textPreview}"`;
  
  if (result.truncated) {
    summary += `\n\n⚠️ Text was truncated to fit length limit`;
  }

  if (result.selection_metadata) {
    const meta = result.selection_metadata;
    summary += `\n\n📊 Selection Details:`;
    summary += `\n• Word count: ${meta.word_count}`;
    summary += `\n• Line count: ${meta.line_count}`;
    summary += `\n• Position: ${Math.round(meta.position.x)}, ${Math.round(meta.position.y)}`;
    
    if (meta.parent_element.tag_name) {
      summary += `\n• Parent element: <${meta.parent_element.tag_name}>`;
      if (meta.parent_element.class_name) {
        summary += ` class="${meta.parent_element.class_name}"`;
      }
    }
    
    if (meta.page_info) {
      summary += `\n• Page: ${meta.page_info.title}`;
      summary += `\n• Domain: ${meta.page_info.domain}`;
    }
  }

  return `${summary}\n\n${JSON.stringify(metadata, null, 2)}`;
}

function formatScrollResult(result, metadata) {
  if (!result.success) {
    return `📜 Scroll failed: ${result.error || "Unknown error"}\n\n${JSON.stringify(metadata, null, 2)}`;
  }

  let summary = `📜 Page scrolled successfully`;
  
  if (result.direction) {
    summary += ` ${result.direction}`;
  }
  
  if (result.amount && result.amount !== "custom") {
    summary += ` (${result.amount})`;
  } else if (result.requested_pixels) {
    summary += ` (${result.requested_pixels}px)`;
  }

  // Field names must match what scrollPage returns (new_position, wait_after).
  if (result.new_position) {
    summary += `\n📍 New position: x=${result.new_position.x}, y=${result.new_position.y}`;
  }

  if (result.wait_after) {
    summary += `\n⏱️ Waited ${result.wait_after}ms after scroll`;
  }

  return `${summary}\n\n${JSON.stringify(metadata, null, 2)}`;
}

function formatLinksResult(result, metadata) {
  if (!result.links || result.links.length === 0) {
    return `🔗 No links found on the page\n\n${JSON.stringify(metadata, null, 2)}`;
  }

  const summary = `🔗 Found ${result.returned} links (${result.total_found} total on page):\n`;
  const currentDomain = result.current_domain ? `\n🌐 Current domain: ${result.current_domain}` : '';
  
  const linksList = result.links.map((link, index) => {
    const typeIcon = link.type === 'internal' ? '🏠' : '🌐';
    const linkText = link.text.length > 50 ? link.text.substring(0, 50) + '...' : link.text;
    const displayText = linkText || '[No text]';
    const title = link.title ? `\n   Title: ${link.title}` : '';
    const domain = link.domain ? ` [${link.domain}]` : '';
    
    return `${index + 1}. ${typeIcon} **${displayText}**${domain}${title}\n   URL: ${link.url}`;
  }).join('\n\n');

  const filterInfo = [];
  if (result.links.some(l => l.type === 'internal') && result.links.some(l => l.type === 'external')) {
    const internal = result.links.filter(l => l.type === 'internal').length;
    const external = result.links.filter(l => l.type === 'external').length;
    filterInfo.push(`📊 Internal: ${internal}, External: ${external}`);
  }
  
  const filterSummary = filterInfo.length > 0 ? `\n${filterInfo.join('\n')}` : '';
  
  return `${summary}${currentDomain}${filterSummary}\n\n${linksList}\n\n${JSON.stringify(metadata, null, 2)}`;
}

function formatTabCreateResult(result, metadata) {
  // Handle batch operations
  if (result.batch_operation) {
    const { summary, created_tabs, warnings, errors } = result;
    
    let output = `🚀 Batch tab creation completed
📊 Summary: ${summary.successful}/${summary.total_requested} tabs created successfully
⏱️ Execution time: ${summary.execution_time_ms}ms
📦 Chunks processed: ${summary.chunks_processed}

`;

    // Add warnings if any
    if (warnings && warnings.length > 0) {
      output += `⚠️ Warnings:\n${warnings.map(w => `   • ${w}`).join('\n')}\n\n`;
    }

    // Add created tabs info
    if (created_tabs && created_tabs.length > 0) {
      output += `✅ Created tabs:\n`;
      created_tabs.forEach((tab, index) => {
        output += `   ${index + 1}. ${tab.title || 'New Tab'} (ID: ${tab.tab_id})\n`;
        output += `      🌐 ${tab.actual_url || tab.url}\n`;
        if (tab.active) output += `      🎯 Active tab\n`;
      });
      output += '\n';
    }

    // Add errors if any
    if (errors && errors.length > 0) {
      output += `❌ Errors:\n`;
      errors.forEach((error, index) => {
        output += `   ${index + 1}. ${error.url}: ${error.error}\n`;
      });
      output += '\n';
    }

    return output + `\n${JSON.stringify(metadata, null, 2)}`;
  }

  // Handle single tab operations (existing logic)
  if (result.success) {
    return `✅ New tab created successfully
🆔 Tab ID: ${result.tab_id}
🌐 URL: ${result.url || 'about:blank'}
🎯 Active: ${result.active ? 'Yes' : 'No'}
📝 Title: ${result.title || 'New Tab'}
${result.warning ? `⚠️ Warning: ${result.warning}` : ''}

${JSON.stringify(metadata, null, 2)}`;
  } else {
    return `❌ Failed to create tab: ${result.error || 'Unknown error'}

${JSON.stringify(metadata, null, 2)}`;
  }
}

function formatTabCloseResult(result, metadata) {
  if (result.success) {
    const tabText = result.count === 1 ? 'tab' : 'tabs';
    return `✅ Successfully closed ${result.count} ${tabText}
🆔 Closed tab IDs: ${result.closed_tabs.join(', ')}

${JSON.stringify(metadata, null, 2)}`;
  } else {
    return `❌ Failed to close tabs: ${result.error || 'Unknown error'}

${JSON.stringify(metadata, null, 2)}`;
  }
}

function formatTabListResult(result, metadata) {
  if (!result.success || !result.tabs || result.tabs.length === 0) {
    return `📋 No tabs found

${JSON.stringify(metadata, null, 2)}`;
  }

  const summary = `📋 Found ${result.count} open tabs:
🎯 Active tab: ${result.summary?.active_tab ?? 'None'}

`;
  
  const tabsList = result.tabs.map((tab, index) => {
    const activeIcon = tab.active ? '🟢' : '⚪';
    const statusInfo = tab.status ? ` [${tab.status}]` : '';
    const pinnedInfo = tab.pinned ? ' 📌' : '';
    
    return `${index + 1}. ${activeIcon} **${tab.title}**${pinnedInfo}${statusInfo}
   🆔 ID: ${tab.id} | 🌐 ${tab.url}`;
  }).join('\n\n');

  return `${summary}${tabsList}

${JSON.stringify(metadata, null, 2)}`;
}

function formatTabSwitchResult(result, metadata) {
  if (result.success) {
    return `✅ Successfully switched to tab
🆔 Tab ID: ${result.tab_id}
📝 Title: ${result.title}
🌐 URL: ${result.url}
🏠 Window ID: ${result.window_id}

${JSON.stringify(metadata, null, 2)}`;
  } else {
    return `❌ Failed to switch tabs: ${result.error || 'Unknown error'}

${JSON.stringify(metadata, null, 2)}`;
  }
}

function formatElementStateResult(result, metadata) {
  const element = result.element_name || result.element_id || 'Unknown element';
  const state = result.state || {};
  
  let summary = `🔍 Element State: ${element}

📊 **Interaction Readiness**: ${state.interaction_ready ? '✅ Ready' : '❌ Not Ready'}

**Detailed State:**
• Disabled: ${state.disabled ? '❌ Yes' : '✅ No'}
• Visible: ${state.visible ? '✅ Yes' : '❌ No'}
• Clickable: ${state.clickable ? '✅ Yes' : '❌ No'}
• Focusable: ${state.focusable ? '✅ Yes' : '❌ No'}
• Has Text: ${state.hasText ? '✅ Yes' : '❌ No'}
• Is Empty: ${state.isEmpty ? '❌ Yes' : '✅ No'}`;

  if (result.current_value) {
    summary += `
📝 **Current Value**: "${result.current_value}"`;
  }

  return `${summary}

${JSON.stringify(metadata, null, 2)}`;
}

function formatPageStyleResult(result, metadata) {
  const statusText = result.success ? 'successfully applied' : 'failed to apply';
  
  let summary = `🎨 Page styling ${statusText}\n\n`;
  
  summary += `📄 **Operation Details:**\n`;
  summary += `• **Mode:** ${result.mode || 'Unknown'}\n`;
  
  if (result.theme) {
    summary += `• **Theme:** ${result.theme}\n`;
  }
  
  if (result.applied_css !== undefined) {
    summary += `• **CSS Applied:** ${result.applied_css} characters\n`;
  }
  
  if (result.description) {
    summary += `• **Result:** ${result.description}\n`;
  }
  
  if (result.remember_enabled) {
    summary += `• **Saved:** Style preferences saved for this domain\n`;
  }
  
  if (result.effect_duration) {
    summary += `• **Effect Duration:** ${result.effect_duration} seconds\n`;
  }
  
  if (result.mood) {
    summary += `• **Mood Applied:** "${result.mood}"\n`;
  }
  
  if (result.intensity) {
    summary += `• **Intensity:** ${result.intensity}\n`;
  }
  
  if (!result.success && result.error) {
    summary += `\n❌ **Error:** ${result.error}\n`;
  }
  
  if (result.warning) {
    summary += `\n⚠️ **Warning:** ${result.warning}\n`;
  }
  
  summary += `\n💡 **Tip:** Use mode="reset" to restore original page styling`;
  
  return `${summary}\n\n${JSON.stringify(metadata, null, 2)}`;
}

module.exports = { formatToolResult };
