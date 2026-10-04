// feedback.js — 解析結果 → 子ども向けの ことば (ほめる・アドバイス・れんしゅう)
//
// 契約 (docs/ARCHITECTURE.md):
//   export function buildFeedback(result) // -> Feedback
//   Feedback = { headline, praise: string[1..3], tips: {metricId,title,text,drill}[0..2], nextGoal }
//
// 方針: ひらがな多め・短い文・ぜったいに 怒らない・できたことを まず ほめる。

// ----------------------------------------------------------------- ことば集
// praise: できたときの ほめことば
// soft:   もう少しのとき (ok) にも使える やさしい ほめことば
// tip:    { title, text, drill }。low / high で向きが変わるものは 両方 用意する
// center: 「ちょうど いい」 範囲の まんなか (low/high の判定に使う)

const PITCH = {
  legLift: {
    praise: 'あしが たかく あがって いるよ！ パワーが たまって いるね',
    soft: 'あしを あげる じゅんびが できて いるよ',
    tip: {
      title: 'あしを もうすこし たかく',
      text: 'まえの あしの ひざを、こしの たかさまで あげてみよう。ためた ちからが ボールに つたわるよ',
      drill: 'かべに てを ついて、かたあしで ひざを こしまで あげて 3びょう ストップ × 10かい',
    },
  },
  stride: {
    praise: 'ふみだしが おおきくて かっこいい！',
    soft: 'まえに しっかり ふみだせて いるね',
    tip: {
      title: 'ふみだしを おおきく',
      text: 'まえの あしを もう ひとあし ぶん とおくへ ふみだそう。からだ ぜんぶで なげられるよ',
      drill: 'じめんに しるしを おいて、そこまで ふみだす シャドーピッチング 10かい',
    },
  },
  elbowHeight: {
    praise: 'ひじが かたの たかさまで あがって いて ばっちり！',
    soft: 'ひじの たかさ、いい かんじだよ',
    center: 97,
    tipLow: {
      title: 'ひじを かたの たかさに',
      text: 'あしが ついた とき、なげる ほうの ひじを かたと おなじ たかさまで あげよう。かたや ひじに やさしいよ',
      drill: 'りょうてを ひろげて「ひこうき」の ポーズ。ひじを かたの たかさに して タオルで シャドーピッチング 10かい',
    },
    tipHigh: {
      title: 'ひじは かたの たかさで OK',
      text: 'ひじが すこし あがりすぎ かも。かたと おなじ たかさくらいが ちょうど いいよ',
      drill: 'かがみの まえで、ひじが かたの よこに くる ポーズを 5かい たしかめよう',
    },
  },
  lean: {
    praise: 'ボールを はなす とき、からだが まえに たおれて いて いいね！',
    soft: 'からだを まえに つかえて きて いるよ',
    center: 35,
    tipLow: {
      title: 'むねを まえに たおそう',
      text: 'ボールを はなす とき、むねを キャッチャーの ほうへ ぐっと たおしてみよう。ボールに いきおいが でるよ',
      drill: 'ひざを ついて すわり、むねを まえに たおしながら かるく なげる「ひざつき キャッチボール」10かい',
    },
    tipHigh: {
      title: 'からだは たおしすぎない',
      text: 'からだが まえに たおれすぎ かも。あたまを まっすぐ キャッチャーに むけたまま なげよう',
      drill: 'あたまの うえに ぼうしを のせた つもりで、おとさない ように ゆっくり シャドーピッチング 10かい',
    },
  },
  twist: {
    praise: 'こしと かたの ひねりが つかえて いるよ！',
    soft: 'からだの ひねりを つかえて きて いるね',
    tip: {
      title: 'からだの ひねりを つかおう',
      text: 'こしが さきに まわって、かたが あとから ついてくる かんじで なげよう。ムチ みたいに しなるよ',
      drill: 'りょうてを むねの まえで くんで、こし → かたの じゅんに まわす「ひねり たいそう」10かい',
    },
  },
  followThrough: {
    praise: 'なげた あとの うでの ふりが さいごまで できて いるね！',
    soft: 'なげた あとも うでを ふれて いるよ',
    tip: {
      title: 'さいごまで うでを ふろう',
      text: 'ボールを はなした あとも、うでを はんたいがわの こし まで ふりおろそう。けがの よぼうにも なるよ',
      drill: 'タオルを もって シャドーピッチング。タオルが はんたいの こしを たたく まで ふる × 10かい',
    },
  },
  headStill: {
    praise: 'あたまが ぶれずに まっすぐ うごいて いて すごい！',
    soft: 'あたまの うごき、なかなか いいよ',
    tip: {
      title: 'あたまを ゆらさない',
      text: 'なげる あいだ、めは ずっと キャッチャーを みて いよう。あたまが ぶれないと コントロールが よくなるよ',
      drill: 'キャッチャーの かわりに かべの しるしを みつめたまま、ゆっくり シャドーピッチング 10かい',
    },
  },
};

const BAT = {
  stanceWidth: {
    praise: 'かまえの あしはばが ちょうど いいね！',
    soft: 'かまえが あんていして きて いるよ',
    center: 45,
    tipLow: {
      title: 'あしを もうすこし ひらこう',
      text: 'かまえる とき、あしを かたはば より すこし ひろく ひらこう。ぐらぐら しにくく なるよ',
      drill: 'かたはばの しるしを じめんに かいて、そこに あしを おいて かまえる れんしゅう 10かい',
    },
    tipHigh: {
      title: 'あしを ひらきすぎない',
      text: 'あしが ひろすぎる かも。かたはば より すこし ひろい くらいが うごきやすいよ',
      drill: 'かたはばの しるしを じめんに かいて、そこに あしを おいて すぶり 10かい',
    },
  },
  headStill: {
    praise: 'スイング ちゅう、あたまが うごかず ボールを よく みて いるね！',
    soft: 'あたまの うごき、なかなか いいよ',
    tip: {
      title: 'あたまを うごかさない',
      text: 'ボールを うつ まで、あたまの いちを かえない ように しよう。めで ボールを さいごまで みようね',
      drill: 'ティーの ボールを じっと みたまま、ゆっくり すぶり 10かい（うった あとも 1びょう ボールの ばしょを みる）',
    },
  },
  hipTurn: {
    praise: 'こしが くるっと よく まわって いるよ！',
    soft: 'こしを まわせて きて いるね',
    tip: {
      title: 'こしを しっかり まわそう',
      text: 'うつ とき、おへそを ピッチャーの ほうへ むける つもりで こしを まわそう。うちかえす ちからが アップするよ',
      drill: 'バットを こしの うしろに あてて もち、おへそを まえに むける「こし まわし」10かい',
    },
  },
  weightShift: {
    praise: 'たいじゅうが うしろから まえへ うまく うごいて いるね！',
    soft: 'まえに たいじゅうを のせられて きて いるよ',
    center: 14,
    tipLow: {
      title: 'まえの あしに のって うとう',
      text: 'うしろの あしに ためた ちからを、うつ ときに まえの あしへ うつそう。つよい だきゅうが うてるよ',
      drill: 'うしろあし → まえあしの じゅんに「いち、に」と こえを だして すぶり 10かい',
    },
    tipHigh: {
      title: 'まえに つっこみすぎない',
      text: 'からだが まえに いきすぎ かも。まえの あしで しっかり ブレーキを かけて うとう',
      drill: 'まえあしの まえに ボールを おいて、ふまない ように すぶり 10かい',
    },
  },
  handHeight: {
    praise: 'トップの てのいちが たかくて ばっちり！',
    soft: 'トップの かたちが できて きて いるよ',
    center: 15,
    tipLow: {
      title: 'てを かたの たかさに',
      text: 'かまえた とき、てを かたの たかさ くらいまで あげて おこう。ボールに バットが でやすく なるよ',
      drill: 'かがみの まえで、てが かたの たかさに くる かまえを 5かい たしかめてから すぶり 10かい',
    },
    tipHigh: {
      title: 'てを あげすぎない',
      text: 'てが すこし たかすぎる かも。かたの すこし うえ くらいが ふりやすいよ',
      drill: 'かがみの まえで、てが かたの すこし うえに くる かまえを 5かい たしかめよう',
    },
  },
  finishBalance: {
    praise: 'ふりおわった あとも ぐらつかず、かっこいい フィニッシュ！',
    soft: 'さいごまで ふりきれて いるよ',
    tip: {
      title: 'フィニッシュで ピタッと とまろう',
      text: 'ふりおわったら、まっすぐ たったまま 3びょう ストップ してみよう。バランスが よくなるよ',
      drill: 'すぶりの あと「1、2、3」と かぞえて ピタッと とまる れんしゅう 10かい',
    },
  },
};

// アドバイスを えらぶ ときの だいじさ (大きいほど 先に えらぶ)
const PRIORITY = {
  pitch: { elbowHeight: 7, followThrough: 6, stride: 5, legLift: 4, headStill: 3, lean: 2, twist: 1 },
  bat: { headStill: 6, weightShift: 5, hipTurn: 4, stanceWidth: 3, handHeight: 2, finishBalance: 1 },
};

const RATING_ORDER = { try: 0, ok: 1, good: 2 };

// ----------------------------------------------------------------- 本体

export function buildFeedback(result) {
  const mode = result && result.mode === 'bat' ? 'bat' : 'pitch';
  const dict = mode === 'bat' ? BAT : PITCH;
  const prio = PRIORITY[mode];

  if (!result || !result.ok) {
    return {
      headline: 'もういちど とってみよう！',
      praise: ['チャレンジ してくれて ありがとう！'],
      tips: [],
      nextGoal:
        (result && result.reason) ||
        (mode === 'bat'
          ? 'あたまから あしまで うつるように、よこ か まえから とってみてね'
          : 'あたまから あしまで うつるように、よこから とってみてね'),
    };
  }

  const metrics = (Array.isArray(result.metrics) ? result.metrics : []).filter(
    (m) => m && dict[m.id] && RATING_ORDER[m.rating] !== undefined,
  );
  const byPrio = (a, b) => (prio[b.id] || 0) - (prio[a.id] || 0);

  // --- ほめる (good → なければ ok → なければ がんばり)
  const good = metrics.filter((m) => m.rating === 'good').sort(byPrio);
  const ok = metrics.filter((m) => m.rating === 'ok').sort(byPrio);
  let praise = good.slice(0, 3).map((m) => dict[m.id].praise);
  if (!praise.length && ok.length) praise = ok.slice(0, 2).map((m) => dict[m.id].soft);
  if (!praise.length) {
    praise = [
      mode === 'bat'
        ? 'さいごまで おもいきり ふれたね！ その きもちが いちばん だいじ！'
        : 'さいごまで いっしょうけんめい なげたね！ その きもちが いちばん だいじ！',
    ];
  }

  // --- アドバイス (try → ok の順、同じなら だいじな方)
  const needs = metrics
    .filter((m) => m.rating !== 'good')
    .sort((a, b) => RATING_ORDER[a.rating] - RATING_ORDER[b.rating] || byPrio(a, b));
  let tips = needs.slice(0, 2).map((m) => makeTip(dict, m));
  if (!tips.length && metrics.length) {
    // ぜんぶ good のときは「レベルアップ」を 1 つだけ
    const m = metrics.slice().sort(byPrio)[0];
    const base = makeTip(dict, m);
    tips = [{ ...base, title: `レベルアップ: ${base.title}`, text: `いまも じょうず！ ${base.text}` }];
  }

  // --- 見出し
  const stars = clampStars(result.stars);
  const best = good[0] || ok[0];
  const cheer =
    mode === 'bat'
      ? stars >= 4
        ? 'ナイスバッティング！'
        : stars >= 3
          ? 'いい スイング！'
          : 'がんばったね！'
      : stars >= 4
        ? 'ナイスピッチ！'
        : stars >= 3
          ? 'いい なげかた！'
          : 'がんばったね！';
  const headline = best ? `${cheer} ${shortPraise(dict[best.id].praise)}` : `${cheer} つぎも いっしょに がんばろう`;

  // --- 次の目標
  const nextGoal = needs.length
    ? `つぎは「${tips[0].title}」を いしきして ${mode === 'bat' ? 'ふって' : 'なげて'} みよう！`
    : stars >= 5
      ? 'この ちょうしで、まいにち すこしずつ れんしゅう しよう！ つぎも ★5 を めざそう！'
      : `この ちょうしで、まいにち すこしずつ れんしゅう しよう！ つぎは ★${stars + 1} を めざそう！`;

  return { headline, praise, tips, nextGoal };
}

function makeTip(dict, m) {
  const d = dict[m.id];
  let tip = d.tip;
  if (!tip) tip = isNumber(d.center) && isNumber(m.value) && m.value > d.center ? d.tipHigh : d.tipLow;
  return { metricId: m.id, title: tip.title, text: tip.text, drill: tip.drill };
}

// 見出し用に ほめことばの 最初の ひとこと だけ使う
function shortPraise(text) {
  const cut = text.split(/[！!。]/)[0];
  return `${cut}！`;
}

function clampStars(s) {
  const v = Math.round(Number(s) || 1);
  return Math.max(1, Math.min(5, v));
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
