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
- **產生站點資訊（美國任一地點，不靠 AI）**（`js/sitegen.js`、`scripts/make_site.py`）：輸入經緯度與半徑，GitHub Actions 自動取得 Overture Maps 建築輪廓，從 USGS 3DEP 公開光達（AWS `usgs-lidar-public` EPT）以固定規則算出每棟建築高度與樹冠格網，加密傳回後在瀏覽器自動建立本機專案。詳見下方〈產生站點資訊〉。
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
│   ├── sitegen.js / sitegen-ui.js  # 產生站點資訊：觸發 workflow、解密結果、建立專案
│   ├── i18n.js                 # 中英切換與 HTML 跳脫工具
│   └── app.js                  # Cesium 視覺化、熱力圖、最佳化與介面邏輯
├── sites/                      # 公開站點設定與路測資料
├── lidar/                      # NOAA Anchorage 光達建物高與樹冠格網
├── scripts/lidar_heights.py    # 光達批次處理腳本（由 GitHub Actions 執行）
├── scripts/make_site.py        # 產生站點資訊：Overture 建築＋3DEP 光達高度與樹冠（make-site.yml 執行）
├── tests/                      # Node 22 內建單元測試與 V2 路測回歸測試
└── docs/DESIGN-NOTES.md        # 完整設計筆記、RF 驗證數據與開發紀錄
```

---

## 產生站點資訊

在「站點與基站」按 **產生站點資訊**，輸入美國任一地點的中心經緯度與半徑（100–1500 m），約 1–10 分鐘後自動建立本機專案（建築下拉選單會出現「產生的建築資料（Overture…）」，並開啟光達高度與樹冠）。

**運作方式（全部是固定規則，不用 AI 推論）**

| 資料 | 來源 | 方法 |
|---|---|---|
| 建築輪廓 | Overture Maps buildings（合併 OSM、Microsoft、Esri Community Maps 等） | 依範圍下載，保留來源的 `height` / `num_floors` |
| 建築高度 | USGS 3DEP 光達（`usgs-lidar-public` 的 Entwine Point Tiles，自動挑涵蓋範圍最完整、年份最新的專案） | 與 `lidar_heights.py` 相同：輪廓內縮 1 m 的第一回波第 90 百分位，減去外圍 1.5–10 m 地面點中位數 |
| 樹冠 | 同一份光達 | 有植被分類（ASPRS 3–5）就用分類；否則用多回波脈衝的第一回波（屋頂通常只有單一回波）；排除橋面、建物、水體；建築輪廓依高度外擴遮罩 |

**保密**：repo 是公開的，所以結果在 Actions 內就以瀏覽器臨時產生的 RSA 公鑰加密（RSA-OAEP-256 + AES-256-GCM），私鑰不可匯出、只存在這個瀏覽器的 IndexedDB；加密檔暫放在 `sitegen-out` 分支（永遠只有一個 commit，匯入後立即刪除，超過一天自動清除）。經緯度不會寫進執行紀錄，但會隨 workflow_dispatch 的輸入保存在 GitHub 的執行記錄中（repo 管理者看得到）。

**一次性設定**：需要一個只限 `site-lens` 的 fine-grained token，Permissions 的 **Actions** 與 **Contents** 設為 Read and write；在面板的「GitHub token」貼上後按「儲存並檢查」。token 只存在瀏覽器的 localStorage。

**限制**：目前只開放美國地點。3DEP 光達的年份與涵蓋因地而異，沒有涵蓋時只會有 Overture 的建築與其內建高度（若有），並在結果中註明。光達之後才蓋的建築會被標成「只量到地面」，保留原本高度。

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
