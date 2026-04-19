// Merlin Spellbook — pure rendering helpers
//
// This module owns the list of preloaded spell templates (SPELLS) and the
// DOM builders for the Spellbook panel. The rest of renderer.js remains
// the stateful host: it fetches spells from the binary, wires the merlin
// IPC callbacks, and owns the collapse/expand state. Extracting the data
// + pure renderer out of renderer.js makes both testable in plain node
// (see spellbook.test.js) without pulling in the whole renderer module.
//
// UMD-style export so the same file works as a <script> tag in Electron
// (attaches to window.MerlinSpellbook) and as a CommonJS require() target
// in node tests.

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.MerlinSpellbook = api;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Morning-briefing preset — one source of truth for both the auto-seed
  // path in renderer.js and the Spellbook template list. Editing the
  // prompt here propagates to both.
  const MORNING_BRIEFING_PRESET = {
    spell: 'morning-briefing',
    cron: '0 5 * * 1-5',
    name: 'Morning Briefing',
    desc: 'Overnight results at 5 AM',
    prompt:
      'Pull overnight results via dashboard. Read .merlin-wisdom.json for benchmarks. ' +
      'Save to .merlin-briefing.json: date, ads (winners/losers/fatigue signals), content (published), ' +
      'revenue (yesterday + week + MER trend), recommendation (one actionable sentence), severity. ' +
      'Set "severity" to "critical" if daily ROAS dropped >30% vs 7-day avg OR an ad account was rejected/disabled OR blended MER fell below 1.5x; ' +
      '"warning" if revenue dropped >10% vs 7-day avg OR any active ad has CPC >2x the vertical average OR spend is pacing >20% over plan; ' +
      'otherwise "ok". This field drives a desktop notification — only mark non-"ok" when the signal is real and actionable. ' +
      'Compare your CTR/ROAS to Wisdom collective averages — flag if above or below. Keep each field 2-4 lines. ' +
      'If slackBotToken exists in config, post a clean digest to the Slack channel using the Slack API (chat.postMessage with the bot token) in this exact format:\n' +
      '"✦ Morning Briefing — [Brand]\n' +
      '━━━━━━━━━━━━━━━\n' +
      '💰 Revenue: $X yesterday · $Xk this week · MER Xx\n' +
      '📈 Winners: [top ad name] at Xx ROAS\n' +
      '⚠️ Action: [one-line recommendation]\n' +
      '━━━━━━━━━━━━━━━"\n' +
      'Keep it to 4 lines max. No fluff. Just numbers and one action item. ' +
      'GEO CHECK (weekly, run on Mondays only): Use WebSearch to search for the brand\'s product category ' +
      '(e.g., "best streetwear brands", "best [vertical] [product]"). Check if the brand appears in AI-generated snippets ' +
      'or top results. Score: appeared in X/5 searches. Save to memory.md: `## GEO Score\n0407|3/5|"best streetwear" yes|"affordable hoodies" no`. ' +
      'If score drops vs last week, flag in briefing.',
  };

  // Agency-tier spell templates with IVT, fatigue detection, and budget
  // optimization rules. The canonical list the Spellbook panel offers
  // users as "activate with one click." Adding a new spell: add it here,
  // nowhere else. Must have { spell, cron, name, desc, prompt }.
  const SPELLS = [
    { spell: 'daily-ads', cron: '0 9 * * 1-5', name: 'Daily Ads', desc: 'Fresh creatives with IVT testing', prompt:
      'Read .merlin-wisdom.json for collective trends (best hooks, formats, models). Read seasonal.json for timing strategy. ' +
      'IVT Protocol: Identify what to test today (rotate: Mon=hooks, Tue=angles, Wed=formats, Thu=scenes, Fri=audiences). ' +
      'Generate 3 variations changing ONLY the test variable. Hold everything else constant. ' +
      'Label each ad: "[Hook Test] Pain Point", "[Hook Test] Social Proof", etc. ' +
      'Use the best-performing hook style from Wisdom data. ' +
      'PREDICTIVE SCORING: Before publishing, check .merlin-wisdom.json for the avg ROAS of this creative\'s hook style and format. ' +
      'Report: "✦ Score: [hook style] averages [X]x ROAS across the network ([N] ads). [format] averages [Y]x." ' +
      'If the hook+format combo averages < 1.5x in Wisdom data, flag it and suggest using a higher-performing hook instead. ' +
      'Publish to Testing campaign at $5-10/day each. ' +
      'Show each image inline. Report: what variable tested, variations created, predicted score, test duration (48h).' },
    { spell: 'performance-check', cron: '0 14 * * 1-5', name: 'Performance Check', desc: 'Deterministic kill/scale rules', prompt:
      'Pull performance from all platforms using dashboard. Apply these DETERMINISTIC rules (no judgment calls):\n' +
      'FATIGUE DETECTION (use ONLY numbers from meta-insights output — never calculate trends yourself):\n' +
      '- If insights show CTR is below 60% of the highest CTR in the output → KILL\n' +
      '- If insights show frequency > 2.5 → WARNING\n' +
      '- If insights show frequency > 4.0 → KILL\n' +
      '- If insights show CPC is 1.5x+ the lowest CPC in the output → KILL\n' +
      'SCALING:\n' +
      '- ROAS > 3x for 3+ days → duplicate to Scaling, increase budget 20%\n' +
      '- ROAS > 2x for 5+ days → increase budget 20% (no duplicate)\n' +
      '- New ads: never kill before 48h unless CPM > 3x vertical average\n' +
      'BUDGET:\n' +
      '- Winners get budget doubled every 48h, max 20% daily increase\n' +
      '- Platform allocation: shift monthly toward highest blended ROAS\n' +
      'Report: killed (with reason), scaled, warnings, net budget change, platform allocation recommendation.' },
    { spell: 'creative-refresh', cron: '0 15 * * 4', name: 'Creative Refresh', desc: 'Generate replacements for fatigued ads', prompt:
      'Pull 14-day performance via dashboard. Read .merlin-wisdom.json for collective winning hooks and formats. ' +
      'IDENTIFY WEAKNESSES (use insights data only — never guess trends):\n' +
      '- Ads tagged FATIGUE or KILL in the Verdict field\n' +
      '- Ads with CTR below 60% of the best-performing ad in the same account\n' +
      '- Ads with frequency > 2.5\n' +
      '- Hook styles underperforming the Wisdom collective avg by >30%\n' +
      'Rank by spend (highest-spend fatigued ads first). Cap total at 10 new creatives per run to control generation cost. ' +
      'SYNTHESIZE BRIEFS — 2 per selected weakness. Map cause → fix:\n' +
      '- Low CTR → new hook (pick top-3 hook styles for this vertical from Wisdom)\n' +
      '- Low ROAS → new angle or offer framing (lean on winners from this brand\'s own history in memory.md)\n' +
      '- High frequency → same audience, new creative angle\n' +
      'Each brief carries a one-line rationale naming the source ad and the metric that triggered it. ' +
      'GENERATE: Call image for static-ad sources, fal for video-ad sources (match the source\'s format and aspect ratio). Respect qualityGate. ' +
      'Save everything under results/refresh_YYYYMMDD_HHMMSS/ with an index.json listing each file → source ad → weakness → brief → rationale. ' +
      'DO NOT PUBLISH. Daily Ads owns publishing — Creative Refresh only stocks the shelf for the user to review in the morning. ' +
      'Show every generated creative inline. ' +
      'End with: "✦ Refreshed [N] creatives · Top pick: [file] fixes [weakness] on [source ad] · Review in results/refresh_YYYYMMDD/ and activate Daily Ads or push manually to promote."' },
    { ...MORNING_BRIEFING_PRESET, desc: MORNING_BRIEFING_PRESET.desc },
    { spell: 'weekly-digest', cron: '0 9 * * 1', name: 'Weekly Digest', desc: 'Monday strategy + benchmarks', prompt:
      'Pull 7-day performance. Compare to previous week AND Wisdom collective benchmarks. ' +
      'List: revenue, spend, MER trend, top 3 ads by ROAS, worst 3 killed, IVT test results (which variable won this week). ' +
      'Read seasonal.json for next week timing strategy. ' +
      'One strategic recommendation: what to test next week based on data.' },
    { spell: 'seo-blog', cron: '0 9 * * 2,4', name: 'SEO Blog Writer', desc: 'Publish posts Tue + Thu', prompt:
      'Run seo-keywords for trending topic. Write 600-word SEO post. Generate featured image. Publish to Shopify via blog-post. Report: title, keyword, URL.' },
    { spell: 'competitor-scan', cron: '0 9 * * 5', name: 'Competitor Watch', desc: 'Friday intel report', prompt:
      'Use competitor-scan for Meta Ad Library. Report: new ads this week, common hooks, themes, and one tactical counter-strategy. ' +
      'Compare their hook styles to Wisdom data — are they using what works or lagging? ' +
      'For each competitor ad found, save a screenshot or description to assets/brands/<brand>/competitor-swipes/ with metadata. ' +
      'Create/update swipes.json: [{"file":"competitor1.jpg","brand":"CompetitorName","hook":"ugc","platform":"meta","date":"2026-04-07","daysRunning":14}]. ' +
      'These appear in the Archive Swipes tab for the user to pair with their own creatives.' },
    { spell: 'email-flows', cron: '0 9 * * 3', name: 'Email Flows', desc: 'Build + optimize automations', prompt:
      'Run email-audit. Missing critical flows (welcome, abandoned cart, post-purchase, win-back)? Create them. ' +
      'Check open/click rates. Suggest subject line improvements based on top-performing hooks from Wisdom data. Report: flows active, created, top/bottom.' },
  ];

  // Escape user-provided strings before putting them in innerHTML. Local
  // copy so the module has zero external deps and works in tests.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Build a single template row (inactive spell). Click wiring is done
   * by the caller — the pure builder doesn't know what activateSpell
   * looks like so tests can swap in a stub.
   */
  function buildTemplateRow(template, onSpellClick) {
    const row = document.createElement('div');
    row.className = 'spell-row spell-row-template';
    row.dataset.spell = template.spell;
    row.innerHTML =
      '<span class="spell-dot dot-pending"></span>' +
      '<div class="spell-info">' +
        '<div class="spell-name">' + escapeHtml(template.name) + '</div>' +
        '<div class="spell-meta">' + escapeHtml(template.desc) + '</div>' +
      '</div>';
    if (typeof onSpellClick === 'function') {
      row.addEventListener('click', () => onSpellClick(template, row));
    }
    return row;
  }

  /**
   * Render the preloaded spell list into `container`. Does NOT touch any
   * binary-provided "active" spells — those are still rendered by
   * renderer.js's loadSpells() before this call. Returns the rendered
   * rows so the caller can keep a reference for collapse/expand.
   */
  function renderSpellbook(container, spells, onSpellClick) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new Error('renderSpellbook: container must be a DOM node');
    }
    const list = Array.isArray(spells) ? spells : [];
    const rows = [];
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'spellbook-empty';
      empty.textContent = 'No spells available.';
      container.appendChild(empty);
      return rows;
    }
    for (const template of list) {
      const row = buildTemplateRow(template, onSpellClick);
      container.appendChild(row);
      rows.push(row);
    }
    return rows;
  }

  /**
   * Show or hide the Spellbook panel. Accepts either the panel element
   * directly or a boolean (in which case it looks up the canonical
   * #magic-panel node). Separated from renderSpellbook so the panel's
   * visibility can be toggled without re-rendering.
   */
  function toggleSpellbook(visible) {
    if (typeof document === 'undefined') return false;
    const panel = document.getElementById('magic-panel');
    if (!panel) return false;
    if (visible) panel.classList.remove('hidden');
    else panel.classList.add('hidden');
    return !panel.classList.contains('hidden');
  }

  return { SPELLS, MORNING_BRIEFING_PRESET, renderSpellbook, toggleSpellbook, buildTemplateRow };
}));
