
const express = require("express");
const CryptoJS = require("crypto-js");

const app = express();
const PORT = process.env.PORT || 3000;

const SITE_URL = "https://hanoi.petrolimex.com.vn";
const PORTAL_URL = "https://portals.petrolimex.com.vn";

const PRICE_FILTER = {
  FilterBy: {
    And: [
      { SystemID: { Equals: "6783dc1271ff449e95b74a9520964169" } },
      { RepositoryID: { Equals: "a95451e23b474fe5886bfb7cf843f53c" } },
      { RepositoryEntityID: { Equals: "3801378fe1e045b1afa10de7c5776124" } },
      { Status: { Equals: "Published" } }
    ]
  },
  SortBy: { LastModified: "Descending" },
  Pagination: {
    TotalRecords: -1,
    TotalPages: 0,
    PageSize: 0,
    PageNumber: 0
  }
};

function base64UrlEncode(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value) {
  let text = value.replace(/-/g, "+").replace(/_/g, "/");
  while (text.length % 4) text += "=";
  return Buffer.from(text, "base64").toString("utf8");
}

function decodeJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Token phiên không đúng định dạng.");
  }

  const expected = CryptoJS.HmacSHA256(
    `${parts[0]}.${parts[1]}`,
    secret
  ).toString(CryptoJS.enc.Base64)
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  if (expected !== parts[2]) {
    throw new Error("Không xác thực được token phiên.");
  }

  return JSON.parse(base64UrlDecode(parts[1]));
}

function createJwt(payload, secret) {
  const header = base64UrlEncode(
    JSON.stringify({ typ: "JWT", alg: "HS256" })
  );

  const body = base64UrlEncode(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000)
    })
  );

  const content = `${header}.${body}`;

  const signature = CryptoJS.HmacSHA256(content, secret)
    .toString(CryptoJS.enc.Base64)
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${content}.${signature}`;
}

async function getJson(url, stage) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json, text/javascript, */*",
      "User-Agent": "Mozilla/5.0 PetrolimexPriceChecker",
      "Referer": SITE_URL + "/index.html",
      "X-Requested-With": "XMLHttpRequest"
    },
    signal: AbortSignal.timeout(20000)
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `${stage}: Máy chủ không trả về dữ liệu JSON. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(`${stage}: Lỗi HTTP ${response.status}`);
  }

  return data;
}

async function createSession() {
  const deviceId =
    CryptoJS.MD5(`${Date.now()}-${Math.random()}`).toString() +
    "@portals";

  const params = new URLSearchParams({
    "x-device-id": base64UrlEncode(deviceId),
    "x-app-name": base64UrlEncode("NGX Websites"),
    "x-app-platform": base64UrlEncode("Desktop PWA"),
    language: "vi-VN"
  });

  const loginData = await getJson(
    `${SITE_URL}/_login?${params.toString()}`,
    "Tạo phiên"
  );

  const data =
    loginData.Data && (loginData.Data.Keys || loginData.Data.keys)
      ? loginData.Data
      : loginData;

  const keys = data.keys || data.Keys;
  const sessionId = data.id || data.ID;
  const encryptedToken = data.Token;

  if (!keys || !sessionId || !encryptedToken) {
    throw new Error("Petrolimex chưa trả về đủ thông tin phiên.");
  }

  const aes = keys.AES || keys.aes;
  const jwtEncrypted = keys.JWT || keys.jwt;

  if (!aes || !jwtEncrypted) {
    throw new Error("Không tìm thấy khóa bảo mật của phiên.");
  }

  const aesKey = CryptoJS.enc.Hex.parse(aes.Key || aes.key);
  const aesIv = CryptoJS.enc.Hex.parse(aes.IV || aes.iv);

  const secret = CryptoJS.AES.decrypt(
    jwtEncrypted,
    aesKey,
    { iv: aesIv }
  ).toString(CryptoJS.enc.Utf8);

  if (!secret) {
    throw new Error("Không giải mã được khóa phiên.");
  }

  const token = decodeJwt(encryptedToken, secret);

  return {
    sessionId,
    deviceId: data.DeviceID || deviceId,
    token,
    secret
  };
}

async function fetchPrices() {
  const session = await createSession();

  const query = new URLSearchParams({
    "object-identity": "search",
    "x-request": base64UrlEncode(JSON.stringify(PRICE_FILTER)),
    "x-object-urls": "true",
    "x-app-token": createJwt(session.token, session.secret),
    "x-session-id": base64UrlEncode(session.sessionId),
    "x-device-id": base64UrlEncode(session.deviceId),
    "x-app-name": base64UrlEncode("NGX Websites"),
    "x-app-platform": base64UrlEncode("Desktop PWA"),
    language: "vi-VN"
  });

  const result = await getJson(
    `${PORTAL_URL}/~apis/portals/cms.item/search?${query.toString()}`,
    "Lấy giá xăng"
  );

  const responseData =
    result.Data && result.Data.Objects
      ? result.Data
      : result;

  if (result.Type === "Error" || result.Error) {
    throw new Error("API Petrolimex trả về lỗi khi lấy giá.");
  }

  if (!Array.isArray(responseData.Objects)) {
    throw new Error("Không tìm thấy danh sách giá xăng trong phản hồi.");
  }

  const products = responseData.Objects.map(item => ({
    id: item.ID,
    name: item.Title,
    englishName: item.EnglishTitle,
    zone1Price: item.Zone1Price,
    zone2Price: item.Zone2Price,
    lastModified: item.LastModified
  }));

  return {
    status: "ok",
    source: "Petrolimex Hà Nội",
    fetchedAt: new Date().toISOString(),
    count: products.length,
    products
  };
}

app.get("/", (req, res) => {
  res.send("Petrolimex price checker is running!");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/prices", async (req, res) => {
  try {
    const data = await fetchPrices();
    res.json(data);
  } catch (error) {
    console.error("Price fetch error:", error.message);

    res.status(502).json({
      status: "error",
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
