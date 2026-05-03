// lib/industry.js — Industry classification + KPI/risk/valuation profiles
// 26 industries + fallback "other"
// Each profile contains: KPIs to use in Scorecard, red flags for risk analysis,
// accounting focus areas, valuation anchor, and Japanese listed peers for benchmarking.

export const INDUSTRIES = {
  saas_btob: {
    label: "SaaS (BtoB)",
    en: "Enterprise SaaS",
    kpis_focus: [
      "ARR 成長率 (年間経常収益)",
      "NRR (Net Retention Rate, >110% が優良)",
      "Rule of 40 (売上成長率 + OP マージン, >40 が優良)",
      "サブスク売上比率"
    ],
    red_flags: [
      "顧客集中度 (Top10 で 30% 超は集中リスク)",
      "ARR 成長率の継続的低下 (3 期連続減速)",
      "Logo Churn 悪化と CAC 高騰の同時発生",
      "サブスク売上比率の低下 / 一時収益への依存度上昇"
    ],
    accounting_focus: [
      "繰延収益 (前受金) と現金収支の乖離",
      "ソフトウェア資産化の妥当性 (社内開発費)",
      "Customer Acquisition Cost の費用化処理"
    ],
    valuation_anchor: "PSR / EV/ARR / Rule of 40",
    benchmark_examples: ["Sansan (4443)", "freee (4478)", "マネーフォワード (3994)", "Cybozu (4776)", "ラクス (3923)"],
    growth_market_relevant: true,
    detect_keywords: ["SaaS", "クラウド", "サブスク", "BtoB プラットフォーム", "受発注", "電子請求", "業務支援", "ERP", "CRM", "MA", "勤怠管理", "経費精算"]
  },

  internet_consumer: {
    label: "インターネット・消費者向け",
    en: "Consumer Internet",
    kpis_focus: [
      "MAU / DAU",
      "ARPU (1 ユーザー当たり収益)",
      "GMV (流通総額) / Take Rate",
      "リテンション率"
    ],
    red_flags: [
      "MAU 成長停滞 + ARPU 鈍化の同時進行",
      "広告売上比率が高すぎる (広告依存の脆弱性)",
      "ユーザー獲得コストの急騰",
      "プラットフォーム規約変更の影響 (Apple / Google)"
    ],
    accounting_focus: [
      "広告収益認識タイミング",
      "決済手数料・代理店手数料の仕訳",
      "ポイント引当金の計算"
    ],
    valuation_anchor: "PSR / EV/MAU / EV/GMV",
    benchmark_examples: ["メルカリ (4385)", "リクルート HD (6098)", "DeNA (2432)", "ZOZO (3092)", "クックパッド (2193)"],
    growth_market_relevant: true,
    detect_keywords: ["プラットフォーム", "C2C", "メルカリ", "EC モール", "SNS", "アプリ", "MAU", "ユーザー基盤"]
  },

  it_service: {
    label: "IT サービス・受託開発・SI",
    en: "IT Services & SI",
    kpis_focus: [
      "受注残 (1.0 倍未満は警戒)",
      "稼働率 (技術者 80% 以上が健全)",
      "1 人当たり粗利",
      "リピート受注率"
    ],
    red_flags: [
      "大型案件依存 (Top3 顧客で 50% 超)",
      "未成工事支出金の積み上がり (赤字案件兆候)",
      "下請構造の深化 (利益率圧迫)",
      "技術者離職率の悪化"
    ],
    accounting_focus: [
      "工事進行基準の適用妥当性",
      "未成工事支出金 vs 受入金のバランス",
      "受注損失引当金の計上有無"
    ],
    valuation_anchor: "PER / EV/EBITDA",
    benchmark_examples: ["NTT データ (9613)", "野村総研 (4307)", "TIS (3626)", "BIPROGY (8056)", "富士ソフト (9749)"],
    growth_market_relevant: false,
    detect_keywords: ["受託開発", "SI", "システム開発", "IT サービス", "システムインテグレーター", "コンサル"]
  },

  game_entertainment: {
    label: "ゲーム・エンタメ",
    en: "Games & Entertainment",
    kpis_focus: [
      "DAU / MAU / ARPPU",
      "タイトル依存度 (Top1 タイトル比率)",
      "課金率 / 課金者 1 人当たり収益",
      "新作パイプライン本数"
    ],
    red_flags: [
      "単一タイトル依存度が 70% 超",
      "新作リリース後の DAU 低下が早い",
      "プラットフォーム手数料率の上昇影響",
      "海外売上比率の急変動"
    ],
    accounting_focus: [
      "コンテンツ資産の減価償却年数",
      "ロイヤリティ収入の認識",
      "海外子会社の連結処理"
    ],
    valuation_anchor: "PER / EV/EBITDA (ヒットタイトル次第で変動)",
    benchmark_examples: ["カプコン (9697)", "コーエーテクモ (3635)", "スクウェア・エニックス (9684)", "バンダイナムコ (7832)", "コナミ (9766)"],
    growth_market_relevant: true,
    detect_keywords: ["ゲーム", "ソーシャルゲーム", "コンテンツ", "アニメ", "エンタメ", "音楽", "映像"]
  },

  bank_finance: {
    label: "銀行・金融サービス",
    en: "Banking & Financial Services",
    kpis_focus: [
      "Net Interest Margin (NIM)",
      "Non-Performing Loan (NPL) 比率",
      "Cost-to-Income 比率",
      "自己資本比率 (Tier1)"
    ],
    red_flags: [
      "貸倒引当金の継続的増加",
      "金利上昇局面での預貸金スプレッド縮小",
      "業種・地域集中による信用集中リスク",
      "サイバーセキュリティインシデント"
    ],
    accounting_focus: [
      "貸倒引当金の見積妥当性",
      "ヘッジ会計の適用",
      "繰延税金資産の回収可能性"
    ],
    valuation_anchor: "PBR / ROE (PBR が一義的)",
    benchmark_examples: ["三菱 UFJ (8306)", "三井住友 (8316)", "みずほ (8411)", "セブン銀行 (8410)", "りそな HD (8308)"],
    growth_market_relevant: false,
    detect_keywords: ["銀行", "信用金庫", "金融", "貸金", "リース", "ノンバンク", "決済"]
  },

  realestate: {
    label: "不動産",
    en: "Real Estate",
    kpis_focus: [
      "NOI (Net Operating Income)",
      "稼働率 (賃貸オフィス 95%+ が健全)",
      "FCR (Free Cash Flow Return)",
      "LTV (Loan-to-Value)"
    ],
    red_flags: [
      "金利上昇による調達コスト圧迫",
      "テナント集中度・退去リスク",
      "再開発エリア集中による地域偏重",
      "不動産含み損 (簿価 vs 時価)"
    ],
    accounting_focus: [
      "投資不動産の時価評価方法",
      "減損兆候の判定基準",
      "リース会計 (借手側)"
    ],
    valuation_anchor: "PBR / NAV / EV/EBITDA",
    benchmark_examples: ["三井不動産 (8801)", "三菱地所 (8802)", "野村不動産 (3231)", "東急不動産 HD (3289)", "オープンハウス (3288)"],
    growth_market_relevant: false,
    detect_keywords: ["不動産", "デベロッパー", "賃貸", "REIT", "マンション", "オフィスビル"]
  },

  insurance: {
    label: "保険",
    en: "Insurance",
    kpis_focus: [
      "Combined Ratio (損害保険)",
      "ESR (Economic Solvency Ratio)",
      "新契約 EV (Embedded Value)",
      "解約・失効率"
    ],
    red_flags: [
      "自然災害集中による Combined Ratio 急上昇",
      "金利低下局面での運用利回り低下",
      "新契約獲得ペースの鈍化",
      "保有契約からの解約増加"
    ],
    accounting_focus: [
      "責任準備金の積立水準",
      "有価証券評価 (その他有価証券)",
      "ヘッジ会計の適用"
    ],
    valuation_anchor: "PER / PEV (Price-to-EV) / PBR",
    benchmark_examples: ["第一生命 HD (8750)", "東京海上 HD (8766)", "MS&AD (8725)", "SOMPO HD (8630)", "T&D HD (8795)"],
    growth_market_relevant: false,
    detect_keywords: ["生命保険", "損害保険", "共済", "再保険"]
  },

  pharma_bio: {
    label: "製薬・バイオ",
    en: "Pharma & Biotech",
    kpis_focus: [
      "R&D 売上比率 (15-20% が目安)",
      "パイプライン本数 (Phase 別)",
      "主力製品依存度",
      "特許切れ (Patent Cliff) リスク"
    ],
    red_flags: [
      "主力製品の特許切れまでの残期間 < 5 年",
      "後続パイプラインの薄さ",
      "薬価改定影響 (国内・海外)",
      "FDA / PMDA の承認遅延"
    ],
    accounting_focus: [
      "開発費の資産計上 vs 費用処理",
      "のれん減損 (M&A で取得した開発品)",
      "返品調整・売上値引引当金"
    ],
    valuation_anchor: "PER / DCF (パイプライン NPV)",
    benchmark_examples: ["武田薬品 (4502)", "アステラス (4503)", "第一三共 (4568)", "中外製薬 (4519)", "塩野義 (4507)"],
    growth_market_relevant: true,
    detect_keywords: ["製薬", "医薬品", "バイオ", "創薬", "ジェネリック", "ワクチン"]
  },

  medical_device: {
    label: "医療機器",
    en: "Medical Devices",
    kpis_focus: [
      "シェア (国内・海外)",
      "保険償還価格動向",
      "新製品売上比率",
      "海外売上比率"
    ],
    red_flags: [
      "保険点数引下げによる単価圧迫",
      "海外規制 (FDA / CE) の対応遅延",
      "リコール・品質問題",
      "技術陳腐化 (AI・ロボット手術)"
    ],
    accounting_focus: [
      "棚卸資産の陳腐化評価",
      "保証費用引当金",
      "海外子会社の連結処理"
    ],
    valuation_anchor: "PER / EV/EBITDA",
    benchmark_examples: ["オリンパス (7733)", "テルモ (4543)", "シスメックス (6869)", "ニプロ (8086)"],
    growth_market_relevant: false,
    detect_keywords: ["医療機器", "ヘルスケア", "診断", "内視鏡", "カテーテル"]
  },

  healthcare_service: {
    label: "医療・介護サービス",
    en: "Healthcare Services",
    kpis_focus: [
      "稼働率 (在宅介護 80%+, 入居系 90%+ が健全)",
      "人件費率 (60-65% が目安)",
      "施設数 / 訪問件数の伸び",
      "報酬改定影響度"
    ],
    red_flags: [
      "介護報酬改定 (3 年ごと) のマイナス影響",
      "人材不足による稼働率低下",
      "M&A で取得した施設の収益性悪化",
      "施設集中による地域リスク"
    ],
    accounting_focus: [
      "のれんの減損兆候",
      "介護給付費未収入金",
      "リース債務 (施設賃貸)"
    ],
    valuation_anchor: "PER / EV/EBITDA",
    benchmark_examples: ["SOMPO ケア", "ベネッセ HD (9783)", "ニチイ学館", "ツクイ (2398)", "メディカル・ケア (2150)"],
    growth_market_relevant: true,
    detect_keywords: ["介護", "医療", "病院", "クリニック", "在宅", "訪問看護", "デイサービス"]
  },

  food_service: {
    label: "飲食",
    en: "Food Service",
    kpis_focus: [
      "FL コスト (食材費 + 人件費, 60% 以下が健全)",
      "客単価 × 客数",
      "既存店売上成長率",
      "店舗数 / 出店ペース"
    ],
    red_flags: [
      "FL コスト 65% 超 (食材費高騰 + 人件費上昇)",
      "既存店売上の継続的マイナス成長",
      "出店ペースが借入金で支えられている",
      "立地集中 (都市部依存・郊外依存)"
    ],
    accounting_focus: [
      "店舗減損 (赤字店舗の継続評価)",
      "リース会計 (店舗賃貸)",
      "売上値引・割引券引当金"
    ],
    valuation_anchor: "PER / EV/EBITDA / 店舗数連動",
    benchmark_examples: ["ゼンショー HD (7550)", "すかいらーく (3197)", "日本マクドナルド (2702)", "コロワイド (7616)", "サイゼリヤ (7581)"],
    growth_market_relevant: false,
    detect_keywords: ["飲食", "外食", "レストラン", "居酒屋", "カフェ", "ファストフード", "回転寿司"]
  },

  retail: {
    label: "小売",
    en: "Retail",
    kpis_focus: [
      "売上総利益率 (業態により差大)",
      "棚卸資産回転率",
      "既存店売上成長率",
      "EC 売上比率"
    ],
    red_flags: [
      "雑収入 (リベート) が利益の柱になっている",
      "既存店マイナスを新規出店でカバーする構造",
      "EC への移行遅れ",
      "PB 比率が低く価格競争に巻き込まれやすい"
    ],
    accounting_focus: [
      "リベート (雑収入) の認識",
      "棚卸資産評価減",
      "店舗減損"
    ],
    valuation_anchor: "PER / EV/EBITDA / 既存店連動",
    benchmark_examples: ["セブン&アイ HD (3382)", "ファーストリテイリング (9983)", "イオン (8267)", "ニトリ HD (9843)", "ローソン (2651)"],
    growth_market_relevant: false,
    detect_keywords: ["小売", "コンビニ", "百貨店", "スーパー", "GMS", "専門店", "ホームセンター"]
  },

  ecommerce: {
    label: "EC・通販",
    en: "E-Commerce",
    kpis_focus: [
      "GMV (流通総額)",
      "Take Rate (手数料率)",
      "リピート率 / アクティブ会員数",
      "1 注文当たり売上 (AOV)"
    ],
    red_flags: [
      "広告投資依存 (CAC 高騰)",
      "プラットフォーム手数料率の上昇圧力",
      "物流コスト (送料無料の負担)",
      "在庫リスク (型落ち・季節商品)"
    ],
    accounting_focus: [
      "返品引当金",
      "ポイント引当金",
      "売上計上タイミング (発送基準 vs 着荷基準)"
    ],
    valuation_anchor: "PSR / EV/GMV",
    benchmark_examples: ["楽天グループ (4755)", "ZOZO (3092)", "Mercari (4385)", "アスクル (2678)", "MonotaRO (3064)"],
    growth_market_relevant: true,
    detect_keywords: ["EC", "通販", "ネット通販", "オンラインショッピング", "D2C"]
  },

  consumer_goods: {
    label: "消費財・化粧品・トイレタリー",
    en: "Consumer Goods",
    kpis_focus: [
      "ブランド別売上構成",
      "海外売上比率",
      "売上総利益率 (40-60%)",
      "新製品売上比率"
    ],
    red_flags: [
      "中国・インバウンド依存度が高い",
      "新製品成功率の低下",
      "原材料費高騰の価格転嫁遅れ",
      "ブランド価値毀損 (品質問題)"
    ],
    accounting_focus: [
      "返品引当金",
      "販売奨励金 (リベート)",
      "棚卸資産評価減"
    ],
    valuation_anchor: "PER / EV/EBITDA / ブランド資産価値",
    benchmark_examples: ["資生堂 (4911)", "コーセー (4922)", "花王 (4452)", "ライオン (4912)", "ユニ・チャーム (8113)"],
    growth_market_relevant: false,
    detect_keywords: ["化粧品", "トイレタリー", "日用品", "消費財", "食品", "飲料"]
  },

  apparel: {
    label: "アパレル・ファッション",
    en: "Apparel",
    kpis_focus: [
      "既存店売上成長率",
      "プロパー消化率 (定価販売比率)",
      "在庫回転率",
      "EC 売上比率"
    ],
    red_flags: [
      "在庫の積み上がり + 値引拡大",
      "プロパー消化率の悪化",
      "ブランドの陳腐化 (Z 世代離れ)",
      "海外展開での損失"
    ],
    accounting_focus: [
      "棚卸資産評価減 (旧シーズン在庫)",
      "店舗減損",
      "返品・値下げ引当金"
    ],
    valuation_anchor: "PER / EV/EBITDA",
    benchmark_examples: ["ファーストリテイリング (9983)", "しまむら (8227)", "ユナイテッドアローズ (7606)", "アダストリア (2685)", "ワールド (3612)"],
    growth_market_relevant: false,
    detect_keywords: ["アパレル", "ファッション", "衣料", "セレクトショップ", "SPA"]
  },

  auto_parts: {
    label: "自動車・部品",
    en: "Automotive & Parts",
    kpis_focus: [
      "生産台数 / 出荷台数",
      "主要顧客集中度 (OEM 依存)",
      "EV 関連売上比率",
      "海外生産比率"
    ],
    red_flags: [
      "EV 移行への対応遅れ (内燃機関依存)",
      "主要 OEM 依存度 50% 超",
      "中国市場の構造変化影響",
      "為替感応度が高い (円高ヘッジ薄)"
    ],
    accounting_focus: [
      "海外子会社の連結処理 (為替)",
      "工具器具備品の減価償却",
      "繰延税金資産の回収可能性"
    ],
    valuation_anchor: "PER / EV/EBITDA / PBR",
    benchmark_examples: ["トヨタ自動車 (7203)", "ホンダ (7267)", "デンソー (6902)", "アイシン (7259)", "豊田自動織機 (6201)"],
    growth_market_relevant: false,
    detect_keywords: ["自動車", "車載", "部品", "OEM", "ティア 1", "EV", "ハイブリッド"]
  },

  machinery: {
    label: "製造・機械",
    en: "Industrial Machinery",
    kpis_focus: [
      "受注残 (1.0 倍以上が健全)",
      "主要顧客集中度",
      "設備稼働率",
      "海外売上比率"
    ],
    red_flags: [
      "受注残の継続的減少",
      "Top3 顧客で 50% 超の依存",
      "設備投資負担と償却負担のバランス",
      "中国向け売上の地政学リスク"
    ],
    accounting_focus: [
      "工事進行基準の適用",
      "棚卸資産の陳腐化評価",
      "保証費用引当金"
    ],
    valuation_anchor: "PER / EV/EBITDA / 受注残連動",
    benchmark_examples: ["ファナック (6954)", "SMC (6273)", "コマツ (6301)", "クボタ (6326)", "ダイキン工業 (6367)"],
    growth_market_relevant: false,
    detect_keywords: ["機械", "工作機械", "産業機械", "FA", "ロボット", "建機"]
  },

  semiconductor: {
    label: "半導体・電子部品",
    en: "Semiconductor & Electronics",
    kpis_focus: [
      "市場シェア (国内・世界)",
      "設備投資率 (売上比 15-25%)",
      "在庫サイクル",
      "粗利率 (40%+ が健全)"
    ],
    red_flags: [
      "在庫サイクル悪化 (半導体在庫日数 100 日超)",
      "主要顧客集中 (Apple / NVIDIA / TSMC 依存等)",
      "中国への輸出規制リスク",
      "巨額設備投資のリターン低下"
    ],
    accounting_focus: [
      "減価償却の方法・年数 (設備の陳腐化)",
      "在庫評価減",
      "為替予約の処理"
    ],
    valuation_anchor: "PER / EV/EBITDA / 受注残連動 / サイクル感応",
    benchmark_examples: ["東京エレクトロン (8035)", "アドバンテスト (6857)", "信越化学 (4063)", "ディスコ (6146)", "ローム (6963)", "村田製作所 (6981)"],
    growth_market_relevant: false,
    detect_keywords: ["半導体", "電子部品", "半導体製造装置", "ウェハー", "メモリー", "イメージセンサー"]
  },

  chemical: {
    label: "化学・素材",
    en: "Chemicals & Materials",
    kpis_focus: [
      "スプレッド (原料 vs 製品価格)",
      "設備稼働率",
      "高機能品売上比率",
      "海外生産比率"
    ],
    red_flags: [
      "原料コスト上昇の価格転嫁遅れ",
      "汎用品比率が高くスプレッド変動の影響大",
      "環境規制対応投資 (脱炭素・PFAS 等)",
      "中国市場でのシェア低下"
    ],
    accounting_focus: [
      "資産除去債務 (土壌汚染・廃棄費用)",
      "棚卸資産評価 (スプレッド変動)",
      "減価償却 (大型プラント)"
    ],
    valuation_anchor: "PER / PBR (シクリカル感応度高)",
    benchmark_examples: ["三菱ケミカル (4188)", "信越化学 (4063)", "住友化学 (4005)", "東レ (3402)", "旭化成 (3407)"],
    growth_market_relevant: false,
    detect_keywords: ["化学", "素材", "石油化学", "高機能材料", "繊維"]
  },

  construction: {
    label: "建設・ゼネコン",
    en: "Construction",
    kpis_focus: [
      "受注残 (1.5 倍以上が健全)",
      "工事粗利率",
      "未成工事支出金 vs 受入金のバランス",
      "海外受注比率"
    ],
    red_flags: [
      "未成工事支出金が受入金を大きく上回る (赤字案件兆候)",
      "工事進行基準の不明瞭な適用",
      "労務費高騰の見積反映遅れ",
      "公共工事依存の景気後退リスク"
    ],
    accounting_focus: [
      "工事進行基準の適用妥当性",
      "受注損失引当金",
      "未成工事支出金の評価"
    ],
    valuation_anchor: "PER / EV/EBITDA / 受注残連動",
    benchmark_examples: ["大成建設 (1801)", "鹿島建設 (1812)", "清水建設 (1803)", "大林組 (1802)", "竹中工務店"],
    growth_market_relevant: false,
    detect_keywords: ["建設", "ゼネコン", "建築", "土木", "プラント"]
  },

  logistics: {
    label: "運輸・物流",
    en: "Transportation & Logistics",
    kpis_focus: [
      "ドライバー稼働率",
      "燃料費転嫁率",
      "車両老朽化 (平均車齢)",
      "主要顧客集中度"
    ],
    red_flags: [
      "ドライバー不足による稼働率低下 (2024 年問題)",
      "燃料費転嫁が遅れる料金体系",
      "傭車比率の上昇 (利益率圧迫)",
      "EC 物流依存度が高く返品物流負担"
    ],
    accounting_focus: [
      "車両減価償却 (耐用年数)",
      "リース会計 (車両・倉庫)",
      "退職給付引当金 (高齢化)"
    ],
    valuation_anchor: "PER / EV/EBITDA",
    benchmark_examples: ["ヤマト HD (9064)", "SG HD (9143)", "日本郵政 (6178)", "セイノー HD (9076)", "センコー (9069)"],
    growth_market_relevant: false,
    detect_keywords: ["物流", "運送", "宅配", "倉庫", "海運", "空運", "鉄道貨物"]
  },

  energy: {
    label: "電力・ガス・エネルギー",
    en: "Energy & Utilities",
    kpis_focus: [
      "発電・販売量",
      "燃料費調整制度の影響",
      "再生可能エネルギー比率",
      "規制料金 vs 自由料金比率"
    ],
    red_flags: [
      "燃料費高騰の料金転嫁遅れ",
      "脱炭素規制への対応コスト",
      "原発再稼働の不確実性",
      "電力自由化での顧客流出"
    ],
    accounting_focus: [
      "資産除去債務 (発電所廃炉費用)",
      "減価償却 (大型インフラ)",
      "燃料費調整制度の会計処理"
    ],
    valuation_anchor: "PER / PBR / 配当利回り",
    benchmark_examples: ["東京電力 HD (9501)", "関西電力 (9503)", "中部電力 (9502)", "ENEOS HD (5020)", "大阪ガス (9532)"],
    growth_market_relevant: false,
    detect_keywords: ["電力", "ガス", "エネルギー", "発電", "石油", "再エネ", "太陽光"]
  },

  telecom: {
    label: "通信",
    en: "Telecommunications",
    kpis_focus: [
      "ARPU (1 契約当たり収益)",
      "Churn (解約率)",
      "Capex / Sales 比率",
      "5G 契約比率"
    ],
    red_flags: [
      "総務省の料金引下げ要請の影響",
      "5G 投資負担 vs 収益化の遅れ",
      "ローミング・MVNO 競合",
      "サブスク売上の鈍化"
    ],
    accounting_focus: [
      "通信設備の減価償却 (大規模長期)",
      "顧客獲得コストの繰延処理",
      "リース会計 (基地局)"
    ],
    valuation_anchor: "PER / EV/EBITDA / 配当利回り",
    benchmark_examples: ["NTT (9432)", "KDDI (9433)", "ソフトバンク (9434)", "楽天モバイル"],
    growth_market_relevant: false,
    detect_keywords: ["通信", "携帯", "モバイル", "光回線", "ISP", "MVNO"]
  },

  trading: {
    label: "商社",
    en: "Trading Companies",
    kpis_focus: [
      "セグメント別利益貢献度",
      "資源 vs 非資源比率",
      "投資先 (持分法) 業績",
      "事業ポートフォリオの分散度"
    ],
    red_flags: [
      "資源価格 (鉄鉱石・石炭・原油) 急変動",
      "投資先のれん減損リスク",
      "新興国カントリーリスク",
      "脱炭素規制の資源事業への影響"
    ],
    accounting_focus: [
      "持分法投資損益",
      "のれん減損 (M&A 取得分)",
      "為替・コモディティヘッジ"
    ],
    valuation_anchor: "PER / PBR (低 PBR が常態)",
    benchmark_examples: ["三菱商事 (8058)", "三井物産 (8031)", "伊藤忠 (8001)", "住友商事 (8053)", "丸紅 (8002)"],
    growth_market_relevant: false,
    detect_keywords: ["商社", "総合商社", "専門商社", "貿易"]
  },

  hr_service: {
    label: "人材サービス",
    en: "HR Services",
    kpis_focus: [
      "稼働率 (派遣)",
      "平均単価",
      "紹介手数料率",
      "求人倍率連動"
    ],
    red_flags: [
      "求人倍率低下による紹介・派遣需要減少",
      "労働者派遣法改正の影響",
      "同一労働同一賃金による単価圧迫",
      "RPA・AI による業務代替"
    ],
    accounting_focus: [
      "売上計上タイミング (派遣・紹介の差)",
      "未払賃金引当金",
      "退職給付債務"
    ],
    valuation_anchor: "PER / EV/EBITDA",
    benchmark_examples: ["リクルート HD (6098)", "パーソル HD (2181)", "パソナ (2168)", "JAC リクルートメント (2124)", "ディップ (2379)"],
    growth_market_relevant: true,
    detect_keywords: ["人材", "派遣", "紹介", "アウトソーシング", "HR", "求人", "転職"]
  },

  media_advertising: {
    label: "メディア・広告",
    en: "Media & Advertising",
    kpis_focus: [
      "広告売上比率",
      "デジタル広告売上比率",
      "視聴率 / 発行部数",
      "クライアント集中度"
    ],
    red_flags: [
      "従来型広告 (TV・新聞) の継続的減少",
      "デジタル化への対応遅れ",
      "クライアント集中度高 (Top10 で 40% 超)",
      "プラットフォーマー (Google/Meta) 依存"
    ],
    accounting_focus: [
      "広告売上の認識タイミング",
      "代理店手数料の計上",
      "コンテンツ資産の減価償却"
    ],
    valuation_anchor: "PER / EV/EBITDA",
    benchmark_examples: ["電通グループ (4324)", "博報堂 DY HD (2433)", "サイバーエージェント (4751)", "セプテーニ HD (4293)"],
    growth_market_relevant: true,
    detect_keywords: ["広告", "メディア", "テレビ", "新聞", "出版", "マーケティング", "PR"]
  },

  other: {
    label: "その他",
    en: "Other",
    kpis_focus: [
      "売上成長率",
      "営業利益率",
      "ROE",
      "自己資本比率"
    ],
    red_flags: [
      "業界全般のマクロ要因",
      "主要顧客集中度",
      "技術・需要動向の変化",
      "規制・法令変更影響"
    ],
    accounting_focus: [
      "売上認識基準",
      "棚卸資産評価",
      "減損兆候"
    ],
    valuation_anchor: "PER / PBR / EV/EBITDA",
    benchmark_examples: [],
    growth_market_relevant: false,
    detect_keywords: []
  }
};

/**
 * Get industry profile by key. Returns "other" if key invalid.
 */
export function getIndustryProfile(key) {
  if (!key || typeof key !== "string") return INDUSTRIES.other;
  return INDUSTRIES[key] || INDUSTRIES.other;
}

/**
 * Fallback: detect industry from Phase 1 data using keyword matching.
 * Used when AI didn't return a valid industry_key.
 */
export function detectIndustryByKeywords(p1Data) {
  if (!p1Data) return "other";

  // Build haystack text from listing rows + tags + blurb + market_tags
  const blurb = p1Data.company?.blurb || "";
  const tags = (p1Data.company?.tags || []).join(" ");
  const marketTags = (p1Data.market_tags || []).map(t => t.label || "").join(" ");
  const listingRows = (p1Data.listing?.rows || [])
    .filter(r => /業種|sector/i.test(r.key || ""))
    .map(r => `${r.val || ""} ${r.small || ""}`)
    .join(" ");
  const haystack = `${blurb} ${tags} ${marketTags} ${listingRows}`.toLowerCase();

  let bestKey = "other";
  let bestScore = 0;
  for (const [key, profile] of Object.entries(INDUSTRIES)) {
    if (key === "other") continue;
    const keywords = profile.detect_keywords || [];
    let score = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  return bestKey;
}

/**
 * Format an industry profile as compact context for Phase 3/4 prompts.
 * Returns a Japanese text block of ~300-500 chars.
 */
export function formatIndustryContext(profile) {
  if (!profile) return "";
  return `【業種: ${profile.label} / ${profile.en}】
■ 重要 KPI: ${profile.kpis_focus.join(" / ")}
■ 業種特有の Red Flag: ${profile.red_flags.join(" / ")}
■ 会計上の注視点: ${profile.accounting_focus.join(" / ")}
■ 推奨バリュエーション軸: ${profile.valuation_anchor}
■ 業種ベンチマーク企業: ${profile.benchmark_examples.length ? profile.benchmark_examples.join(", ") : "—"}
${profile.growth_market_relevant ? "■ JPX グロース市場「事業計画及び成長可能性に関する事項」開示が参考になる業種" : ""}`;
}

/**
 * Format the industry enum for inclusion in Phase 1 prompt.
 */
export function formatIndustryEnumForPrompt() {
  const lines = [];
  for (const [key, profile] of Object.entries(INDUSTRIES)) {
    if (key === "other") {
      lines.push(`- ${key}: 上記に当てはまらない場合`);
      continue;
    }
    const examples = profile.benchmark_examples.slice(0, 2).join(", ");
    lines.push(`- ${key}: ${profile.label}${examples ? ` (例: ${examples})` : ""}`);
  }
  return lines.join("\n");
}
