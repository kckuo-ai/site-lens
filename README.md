# SiteLens（站點覆蓋評估）

零後端、零建置的瀏覽器 5G / CBRS 3D 多徑射線追蹤與站點覆蓋評估工具，部署於 GitHub Pages。

- **線上版（Anchorage n48 含 V2 路測）**：https://kckuo-ai.github.io/site-lens/
- **線上版（高雄仁愛之家 n79 多 RU）**：https://kckuo-ai.github.io/site-lens/?site=kaohsiung

---

## 主要功能

- **純數學 3D 射線引擎**（`js/rt.js`）：支援直射（LOS）、一次／二次鏡像反射（牆面與地面）、建築穿透（3GPP TR 38.901 材料損耗）、屋頂／山脊單一刃形繞射（ITU-R P.526）、AWS Terrarium 地形與 NOAA 光達樹冠衰減（Weissberger）。
- **多站點與保密專案管理**（`js/site-manager.js`）：
  - 公開站點設定外置於 `sites/index.json` 與 `sites/<id>/site.json`。
  - 支援在瀏覽器內 **「＋ 新增專案」**（僅存本機 IndexedDB，不上傳公開 repo）以及 **`.sitelens.json` 完整專案檔匯入／匯出**，方便團隊傳遞客戶保密案場。
- **建築資料與編修**：支援內附 OSM、即時 Overpass、內政部國土測繪中心三維建物（NLSC 3D Tiles 1.1）、通用版電子地圖自動描邊（EMAP z18）、Google 寫實 3D 量高，以及地圖手動新增／多選批次編修建築。
- **鏈路預算、路測校準與最佳化**：支援 `n48` / `n77` / `n78` / `n79`、三扇區／全向／多 RU（含 D-MIMO 相干 JT）、RSRP / SINR 熱力圖、實測路測比對校準與方位／下傾角最佳化。

---

## 目錄結構

```text
site-lens/
├── index.html                  # 主頁 HTML 外殼
├── css/app.css                 # 桌面／平板／手機抽屜版面樣式
├── js/
│   ├── rt.js                   # 純數學射線引擎（無 DOM/Cesium 依賴）
│   ├── rf.js                   # 3GPP 頻段、NRB、天線方向圖與建築材料分類
│   ├── storage.js              # IndexedDB 大型快取與 localStorage 自動遷移
│   ├── site-manager.js         # 公開站點載入、本機自訂專案、.sitelens.json 匯入匯出
│   ├── i18n.js                 # 中英切換與 HTML 跳脫工具
│   └── app.js                  # Cesium 視覺化、熱力圖、最佳化與介面邏輯
├── sites/                      # 公開站點設定與路測資料
├── lidar/                      # NOAA Anchorage 光達建物高與樹冠格網
├── scripts/lidar_heights.py    # 光達批次處理腳本（由 GitHub Actions 執行）
├── tests/                      # Node 22 內建單元測試與 V2 路測回歸測試
└── docs/DESIGN-NOTES.md        # 完整設計筆記、RF 驗證數據與開發紀錄
```

---

## 本機開發與測試

不需要 `npm install` 或任何建置步驟：

```bash
# 1. 啟動靜態伺服器（支援 ES Modules）
python3 -m http.server 8080

# 2. 執行單元測試與 Anchorage V2 路測回歸測試（需要 Node.js 22+）
node --test tests/*.test.mjs
```

詳細設計決策與驗證數據請參閱 [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md)。
