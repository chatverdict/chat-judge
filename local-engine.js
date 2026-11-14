/* ChatVerdict local-only engine prototype.
   Parses a WhatsApp-style export, pseudonymizes speakers, computes per-person stats,
   and renders a template verdict - all without any data leaving the device.
   Plain script (no modules) so the same file can be tested in node and shipped in-page. */
(function (root) {
  'use strict';

  var LINE_RE = /^\[?(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\]?\s*[-–]?\s*([^:\n]{1,40}):\s?(.*)$/;

  function parseChat(text) {
    var lines = String(text).split(/\r?\n/), msgs = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(LINE_RE);
      if (m) {
        cur = { date: m[1], hour: +m[2], min: +m[3], sender: m[4].trim(), text: m[5] || '' };
        msgs.push(cur);
      } else if (cur && lines[i].trim()) {
        cur.text += ' ' + lines[i].trim();
      }
    }
    return msgs;
  }

  function pseudonymize(msgs, aliases) {
    var speakers = [], seen = {};
    msgs.forEach(function (m) { if (!seen[m.sender]) { seen[m.sender] = 1; speakers.push(m.sender); } });
    var map = {};
    speakers.forEach(function (s, i) { map[s] = (aliases && aliases[s]) || 'Speaker ' + (i + 1); });
    // replace speaker names inside message bodies too (longest first, case-insensitive)
    var names = speakers.slice().sort(function (a, b) { return b.length - a.length; });
    // Unicode-aware boundaries (\b is ASCII-only and fails on Hebrew etc.)
    var bodyRes = names.map(function (n) {
      var esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { re: new RegExp('(?<![\\p{L}\\p{N}])' + esc + '(?![\\p{L}\\p{N}])', 'giu'), alias: map[n] };
    });
    function scrubText(t) {
      var out = String(t);
      bodyRes.forEach(function (x) { out = out.replace(x.re, x.alias); });
      return minimize(out);
    }
    var out = msgs.map(function (m) {
      return { date: m.date, hour: m.hour, min: m.min, sender: map[m.sender], text: scrubText(m.text) };
    });
    return { messages: out, speakers: speakers.map(function (s) { return map[s]; }), mapping: map };
  }

  function minimize(text) {
    return String(text)
      .replace(/https?:\/\/\S+/gi, '[link]')
      .replace(/\b\+?\d[\d\s\-()]{7,}\d\b/g, '[number]')
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]');
  }

  function stats(msgs) {
    var per = {}, order = [];
    msgs.forEach(function (m) {
      if (!per[m.sender]) {
        per[m.sender] = { name: m.sender, count: 0, words: 0, oneWord: 0, questions: 0,
                          lol: 0, emoji: 0, lateNight: 0, media: 0, starts: 0, links: 0, replies: 0, replyMins: 0 };
        order.push(m.sender);
      }
      var s = per[m.sender], t = m.text, w = t.split(/\s+/).filter(Boolean).length;
      s.count++; s.words += w;
      if (w <= 2) s.oneWord++;
      if (t.indexOf('?') >= 0) s.questions++;
      if (/\b(lol|lmao|xd|mdr|ptdr|w{2,}|(?:ha){2,}|(?:ja){2,}|(?:je){2,}|(?:he){2,})\b|笑|草|חחח|😂|🤣|😄/i.test(t)) s.lol++;
      if (/[😀-🙏🌀-🫿☀-➿]/u.test(t)) s.emoji++;
      if (m.hour >= 0 && m.hour < 5) s.lateNight++;
      if (/<Media omitted>|image omitted|video omitted|קובץ מצורף/i.test(t)) s.media++;
      if (t.indexOf('[link]') >= 0 || /https?:\/\//.test(t)) s.links++;
    });
    // conversation starters + reply speed (same-day gaps only, capped at 120 min)
    var prev = null;
    msgs.forEach(function (m) {
      if (prev && prev.sender !== m.sender) {
        var gapH = (m.date !== prev.date) ? 24 - prev.hour + m.hour : m.hour - prev.hour;
        if (gapH >= 3) per[m.sender].starts++;
        var gapMin = (m.hour * 60 + m.min) - (prev.hour * 60 + prev.min);
        if (m.date === prev.date && gapMin >= 0 && gapMin <= 120) {
          per[m.sender].replies++;
          per[m.sender].replyMins += gapMin;
        }
      }
      prev = m;
    });
    var total = msgs.length;
    return order.map(function (name) {
      var s = per[name];
      s.share = total ? Math.round(100 * s.count / total) : 0;
      s.avgWords = s.count ? Math.round(10 * s.words / s.count) / 10 : 0;
      s.lolRate = s.count ? Math.round(100 * s.lol / s.count) : 0;
      s.oneWordRate = s.count ? Math.round(100 * s.oneWord / s.count) : 0;
      s.avgReplyMins = s.replies >= 8 ? Math.round(s.replyMins / s.replies) : null;
      return s;
    }).sort(function (a, b) { return b.count - a.count; });
  }



  // Median helper for group comparisons.
  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  var LOCALES = {
    en: {
      titles: { share: 'The Megaphone', essay: 'The Essayist', oneword: 'The One-Word Wonder',
        laugh: 'The Laugh Track', interrogator: 'The Interrogator', instigator: 'The Instigator',
        archivist: 'The Archivist', nightowl: 'The 3AM Philosopher', fastreply: 'The Instant Responder', slowreply: 'The Seen-Zone',
        first: 'First Among Equals', even: 'Evenly Matched' },
      base: function (s) { return s.count + ' messages (' + s.share + '% of the chat), averaging ' + s.avgWords + (s.avgWords === 1 ? ' word' : ' words') + ' each. '; },
      share: function (s, med) { return 'The most talkative: ' + s.share + '% of all messages, versus a group median of ' + Math.round(med) + '%. '; },
      essay: function (s, med) { return 'Writes the longest messages by far: ' + s.avgWords + ' words on average, versus a group median of ' + Math.round(10 * med) / 10 + '. '; },
      oneword: function (s, med) { return s.oneWordRate + '% of messages are one word long (group median ' + Math.round(med) + '%). '; },
      laugh: function (s, med) { return s.lolRate + '% of messages are laughter - "lol", "haha", "jaja" and friends, or laughing emojis (group median ' + Math.round(med) + '%). '; },
      interrogator: function (s, med) { return 'Asked ' + s.questions + ' questions - ' + (s.questions - Math.round(med)) + ' more than the group median. '; },
      instigator: function (s) { return 'Started ' + s.starts + ' conversation threads, more than anyone else here. '; },
      archivist: function (s) { return 'Sent ' + s.media + ' media items - the group\u2019s unofficial archivist. '; },
      nightowl: function (s) { return s.lateNight + ' messages between midnight and 5am. The court notes the sleep schedule and is concerned. '; },
      fastreply: function (s, med) { return 'Average reply time ' + s.avgReplyMins + (s.avgReplyMins === 1 ? ' minute' : ' minutes') + ', versus a group median of ' + Math.round(med) + ' - replies before the notification sound finishes. '; },
      slowreply: function (s, med) { return 'Average reply time ' + s.avgReplyMins + (s.avgReplyMins === 1 ? ' minute' : ' minutes') + ', versus a group median of ' + Math.round(med) + '. The court heard the notification. Twice. '; },
      similar: 'Nothing in the numbers sets this speaker apart from the others - the court could not honestly tell them apart from the pack. '
    },
    es: {
      titles: { share: 'El Meg\u00e1fono', essay: 'El Ensayista', oneword: 'El Monos\u00edlabo',
        laugh: 'La Carcajada', interrogator: 'El Interrogador', instigator: 'El Instigador',
        archivist: 'El Archivero', nightowl: 'El Fil\u00f3sofo de las 3AM', fastreply: 'El Rel\u00e1mpago', slowreply: 'El Zona-Visto',
        first: 'Primero Entre Iguales', even: 'Parejo' },
      base: function (s) { return s.count + ' mensajes (' + s.share + '% del chat), con una media de ' + s.avgWords + (s.avgWords === 1 ? ' palabra' : ' palabras') + ' cada uno. '; },
      share: function (s, med) { return 'El m\u00e1s parlanch\u00edn: el ' + s.share + '% de todos los mensajes, frente a una mediana del grupo del ' + Math.round(med) + '%. '; },
      essay: function (s, med) { return 'Escribe los mensajes m\u00e1s largos con diferencia: ' + s.avgWords + ' palabras de media, frente a una mediana de ' + Math.round(10 * med) / 10 + '. '; },
      oneword: function (s, med) { return 'El ' + s.oneWordRate + '% de sus mensajes son de una sola palabra (mediana del grupo: ' + Math.round(med) + '%). '; },
      laugh: function (s, med) { return 'El ' + s.lolRate + '% de sus mensajes son risas - "lol", "jaja", "haha" y amigos, o emojis de risa (mediana del grupo: ' + Math.round(med) + '%). '; },
      interrogator: function (s, med) { return 'Hizo ' + s.questions + ' preguntas - ' + (s.questions - Math.round(med)) + ' m\u00e1s que la mediana del grupo. '; },
      instigator: function (s) { return 'Abri\u00f3 ' + s.starts + ' hilos de conversaci\u00f3n, m\u00e1s que nadie aqu\u00ed. '; },
      archivist: function (s) { return 'Envi\u00f3 ' + s.media + ' archivos multimedia - el archivero no oficial del grupo. '; },
      nightowl: function (s) { return s.lateNight + ' mensajes entre medianoche y las 5am. El tribunal toma nota de su horario de sue\u00f1o y est\u00e1 preocupado. '; },
      fastreply: function (s, med) { return 'Responde en ' + s.avgReplyMins + (s.avgReplyMins === 1 ? ' minuto' : ' minutos') + ' de media, frente a una mediana del grupo de ' + Math.round(med) + ' - contesta antes de que termine el sonido de notificaci\u00f3n. '; },
      slowreply: function (s, med) { return 'Responde en ' + s.avgReplyMins + (s.avgReplyMins === 1 ? ' minuto' : ' minutos') + ' de media, frente a una mediana del grupo de ' + Math.round(med) + '. El tribunal oy\u00f3 la notificaci\u00f3n. Dos veces. '; },
      similar: 'Nada en los n\u00fameros distingue a este participante de los dem\u00e1s - el tribunal no pudo separarlo honestamente del grupo. '
    },
    ja: {
      titles: { share: '\u30e1\u30ac\u30db\u30f3', essay: '\u30a8\u30c3\u30bb\u30a4\u30b9\u30c8', oneword: '\u4e00\u8a00\u8077\u4eba',
        laugh: '\u7b11\u3044\u62c5\u5f53', interrogator: '\u5c02\u554f\u5b98', instigator: '\u706b\u4ed8\u3051\u5f79',
        archivist: '\u30a2\u30fc\u30ad\u30d3\u30b9\u30c8', nightowl: '\u6df1\u591c3\u6642\u306e\u54f2\u5b66\u8005', fastreply: '\u5373\u8fd4\u4fe1\u306e\u4eba', slowreply: '\u65e2\u8aad\u30b9\u30eb\u30fc\u738b',
        first: '\u540c\u7b49\u306e\u9996\u5e2d', even: '\u4e92\u89d2' },
      base: function (s) { return s.count + '\u4ef6\u306e\u30e1\u30c3\u30bb\u30fc\u30b8(\u30c1\u30e3\u30c3\u30c8\u306e' + s.share + '%)\u3001\u5e73\u5747' + s.avgWords + '\u8a9e\u3002'; },
      share: function (s, med) { return '\u6700\u3082\u304a\u3057\u3083\u3079\u308a: \u5168\u30e1\u30c3\u30bb\u30fc\u30b8\u306e' + s.share + '%(\u30b0\u30eb\u30fc\u30d7\u4e2d\u592e\u5024' + Math.round(med) + '%)\u3002'; },
      essay: function (s, med) { return '\u6700\u9577\u30e1\u30c3\u30bb\u30fc\u30b8: \u5e73\u5747' + s.avgWords + '\u8a9e(\u4e2d\u592e\u5024' + Math.round(10 * med) / 10 + '\u8a9e)\u3002'; },
      oneword: function (s, med) { return s.oneWordRate + '%\u304c1\u8a9e\u30e1\u30c3\u30bb\u30fc\u30b8(\u4e2d\u592e\u5024' + Math.round(med) + '%)\u3002'; },
      laugh: function (s, med) { return '\u767a\u8a00\u306e' + s.lolRate + '%\u304c\u7b11\u3044 - \u300clol\u300d\u300cwww\u300d\u300c\u8349\u300d\u306a\u3069\u3001\u307e\u305f\u306f\u7b11\u3044\u7d75\u6587\u5b57(\u4e2d\u592e\u5024' + Math.round(med) + '%)\u3002'; },
      interrogator: function (s, med) { return '\u8cea\u554f\u306f' + s.questions + '\u4ef6 - \u30b0\u30eb\u30fc\u30d7\u4e2d\u592e\u5024\u3088\u308a' + (s.questions - Math.round(med)) + '\u4ef6\u591a\u3044\u3002'; },
      instigator: function (s) { return '\u4f1a\u8a71\u3092' + s.starts + '\u56de\u958b\u59cb - \u30b0\u30eb\u30fc\u30d7\u6700\u591a\u3002'; },
      archivist: function (s) { return '\u30e1\u30c7\u30a3\u30a2\u9001\u4fe1' + s.media + '\u4ef6 - \u30b0\u30eb\u30fc\u30d7\u306e\u975e\u516c\u8a8d\u30a2\u30fc\u30ad\u30d3\u30b9\u30c8\u3002'; },
      nightowl: function (s) { return '\u6df1\u591c0\u6642\u301c5\u6642\u306b' + s.lateNight + '\u4ef6\u3002\u6cd5\u5ef7\u306f\u7761\u7720\u30b9\u30b1\u30b8\u30e5\u30fc\u30eb\u3092\u61f8\u5ff5\u3057\u3066\u3044\u308b\u3002'; },
      fastreply: function (s, med) { return '\u5e73\u5747\u8fd4\u4fe1\u6642\u9593' + s.avgReplyMins + '\u5206(\u30b0\u30ebープ中央値' + Math.round(med) + '\u5206)\u3002\u901a知音が終わ\u308b前に返\u4fe1\u3059\u308b\u3002'; },
      slowreply: function (s, med) { return '\u5e73\u5747\u8fd4\u4fe1\u6642\u9593' + s.avgReplyMins + '\u5206(\u30b0\u30ebープ中央値' + Math.round(med) + '\u5206)\u3002\u6cd5\u5ef7\u306f\u901a知\u97f3を\u805e\u3044た\u3002\u4e8c度\u3082\u3002'; },
      similar: '\u6570\u5b57\u4e0a\u3001\u4ed6\u306e\u53c2\u52a0\u8005\u3068\u306e\u660e\u78ba\u306a\u5dee\u306f\u898b\u3089\u308c\u306a\u3044 - \u6cd5\u5ef7\u306f\u6b63\u76f4\u306b\u300c\u533a\u5225\u4e0d\u80fd\u300d\u3068\u5224\u5b9a\u3057\u305f\u3002'
    }
  };

  // A trait is distinctive only when the speaker leads the group on a measured
  // metric by a real margin. No margin -> honest similarity, no forced persona.
  function distinctiveTraits(s, st, L) {
    var traits = [];
    function lead(metric, minLead, key, weight) {
      var vals = st.map(function (x) { return x[metric]; });
      var med = median(vals);
      var top = Math.max.apply(null, vals);
      if (s[metric] === top && s[metric] - med >= minLead) {
        traits.push({ weight: weight, key: key, line: L[key](s, med) });
      }
    }
    lead('share', 10, 'share', 6);
    lead('avgWords', 4, 'essay', 5);
    lead('oneWordRate', 20, 'oneword', 5);
    lead('lolRate', 20, 'laugh', 4);
    lead('questions', 15, 'interrogator', 4);
    lead('starts', 15, 'instigator', 3);
    lead('media', 10, 'archivist', 3);
    lead('lateNight', 8, 'nightowl', 4);
    // reply speed: need valid avgReplyMins for all compared speakers
    var replyVals = st.map(function (x) { return x.avgReplyMins; }).filter(function (v) { return v !== null; });
    if (s.avgReplyMins !== null && replyVals.length >= 2) {
      var rmed = median(replyVals);
      var rmin = Math.min.apply(null, replyVals);
      var rmax = Math.max.apply(null, replyVals);
      if (s.avgReplyMins === rmin && rmed - s.avgReplyMins >= 5) {
        traits.push({ weight: 4, key: 'fastreply', line: L.fastreply(s, rmed) });
      } else if (s.avgReplyMins === rmax && s.avgReplyMins - rmed >= 20) {
        traits.push({ weight: 4, key: 'slowreply', line: L.slowreply(s, rmed) });
      }
    }
    traits.sort(function (a, b) { return b.weight - a.weight; });
    return traits;
  }

  function verdictFor(s, rank, st, L, usedTitles) {
    var lines = [];
    var head = s.name + ' - ';
    var traits = distinctiveTraits(s, st, L);
    var title = null, i;
    for (i = 0; i < traits.length; i++) {
      var cand = L.titles[traits[i].key];
      if (!usedTitles[cand]) { title = cand; usedTitles[title] = 1; break; }
    }
    var body = L.base(s);
    if (title) {
      for (i = 0; i < traits.length; i++) body += traits[i].line;
    } else {
      var baseT = rank === 0 ? L.titles.first : L.titles.even;
      title = baseT;
      var n = 2;
      while (usedTitles[title]) { title = baseT + ' #' + n; n++; }
      usedTitles[title] = 1;
      body += L.similar;
    }
    lines.push(head + title);
    lines.push(body);
    return lines.join('\n');
  }

  function analyze(chatText, aliases, locale) {
    var msgs = parseChat(chatText);
    var p = pseudonymize(msgs, aliases);
    var st = stats(p.messages);
    var total = p.messages.length;
    var L = LOCALES[locale] || LOCALES.en;
    var usedTitles = {};
    var verdicts = st.map(function (s, i) { return verdictFor(s, i, st, L, usedTitles); });
    return {
      totalMessages: total,
      speakers: st,
      verdicts: verdicts,
      pseudonymizedSample: p.messages.slice(0, 3),
      mapping: p.mapping
    };
  }

  root.ChatVerdictLocal = { parseChat: parseChat, pseudonymize: pseudonymize, minimize: minimize, stats: stats, analyze: analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ChatVerdictLocal;
})(typeof window !== 'undefined' ? window : globalThis);
