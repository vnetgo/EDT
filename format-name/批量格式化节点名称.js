export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 如果路径以 "/sub/" 开头，则处理订阅请求
    if (url.pathname.startsWith('/sub/')) {
      return handleSubRequest(request, env);
    }
    // 默认返回前端页面
    return new Response(frontendPage(env), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// 工具函数模块
const tools = {
  base64: {
    encode: (str) => {
      return btoa(String.fromCharCode(...new Uint8Array(new TextEncoder().encode(str))));
    },
    decode: (str) => {
      return new TextDecoder().decode(Uint8Array.from(atob(str), c => c.charCodeAt(0)));
    }
  },

  // 将域名解析为IP
  async domainToIP(domain) {
    const dnsapi = [
      `https://223.5.5.5/resolve?name=${domain}`,
      `https://dns.google/resolve?name=${domain}`
    ];
    for (const url of dnsapi) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json();
        if (!data?.Answer || !Array.isArray(data.Answer)) continue;
        const aRecord = data.Answer.find(record => record.type === 1);
        if (aRecord?.data) {
          return { ip: aRecord.data };
        }
      } catch (err) {
        console.error(`请求 ${url} 失败:`, err);
        continue;
      }
    }
    return { ip: '未知' };
  },

  // 查询IP信息，返回国家代码和org组织名
  async parseIPInfo(ip) {
    const ipapi = [
      `https://ip.eooce.com/${ip}`,
      `https://ipinfo.io/${ip}/json`
    ];
    
    const results = await Promise.allSettled(ipapi.map(url =>
      fetch(url)
        .then(resp => resp.ok ? resp.json() : Promise.reject(`请求 ${url} 失败`))
        .catch(err => (console.error(err), null)) 
    ));
    
    let finalCountry = null, finalOrg = null;
    for (const [i, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value) {
        const data = result.value;
        let country = i === 0 ? data.country_code : data.country;
        let org = i === 0 ? data.organization : data.org;
        if (org) org = i === 0 ? org.split(/[-,]/)[0].trim() : org.replace(/^AS\d+\s*/, "");
        if (country && org) return { country, org };
        finalCountry ||= country;
        finalOrg ||= org;
      }
    }
  
    return { country: finalCountry || "未知国家", org: finalOrg || "未知" };
  },
  
  // 获取国家代码的 emoji
  getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2 || !/^[A-Za-z]{2}$/.test(countryCode)) {
      return '🏳';
    }
    return String.fromCodePoint(...[...countryCode.toUpperCase()].map(c => 127397 + c.charCodeAt(0)));
  }
};

// 公共辅助函数：判断 add 是域名还是 IP
async function domainORip(add) {
  let ip;
  if (add && add.startsWith('[') && add.endsWith(']')) {
    add = add.slice(1, -1);
  }
  // 判断是否为 IPv4 或 IPv6
  if (add && (/^\d+\.\d+\.\d+\.\d+$/.test(add) || add.includes(':'))) {
    ip = add;
  } else {
    const result = await tools.domainToIP(add);
    ip = result.ip;
  }
  const { country, org } = await tools.parseIPInfo(ip);
  return { country, org };
}

// 公共辅助函数：格式化节点名称
function newNodeName(country, org, env, useFlag, useSuffix, useOrg) {
  if (!useFlag && !useSuffix && !useOrg) return country;
  let parts = [];
  if (useFlag) {
    const flag = tools.getFlagEmoji(country);
    if (flag) parts.push(flag);
  }
  parts.push(country);
  if (useOrg) parts.push(org);
  if (useSuffix) parts.push(env.LINK_RENAME || 'MyNode');
  return parts.filter(Boolean).join(' | ');
}

// 订阅处理模块
async function handleSubRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.slice(5);

  let rawlinks = [];
  let useFlag = true;
  let useSuffix = true;
  let useOrg = true;

  if (request.method === 'POST') {
      rawlinks = decodeURIComponent(path).split('\n');
      useFlag = request.headers.get('X-Flag') === 'true';
      useSuffix = request.headers.get('X-Suffix') === 'true';
      useOrg = request.headers.get('X-Org') === 'true';
  } else if (request.method === 'GET') {
      rawlinks = [decodeURIComponent(path + url.search + url.hash)];
      useFlag = true;
      useSuffix = true;
      useOrg = false;
  }

  let links = [];

  for (const link of rawlinks) {
    if (link.startsWith('http://') || link.startsWith('https://')) {
      try {
        const resp = await fetch(link);
        if (!resp.ok) continue;
        let text = await resp.text();
        if (/^[A-Za-z0-9+/=]+$/.test(text.replace(/\s+/g, ''))) {
            try {
                text = tools.base64.decode(text);
            } catch (e) {
                console.error(`Base64 解码失败: ${link}`);
                continue;
            }
        }
        links.push(...text.split('\n').map(l => l.trim()).filter(l => l));
      } catch (err) {
        console.error(`请求订阅地址失败: ${link}`, err);
        continue;
      }
    } else {
      links.push(link.trim());
    }
  }

  // 处理各个节点链接
  const processed = await Promise.all(links.map(async link => {
    if (link.startsWith('vmess://')) {
      return processVmess(link, env, useFlag, useSuffix, useOrg);
    } else if (
      link.startsWith('vless://') ||
      link.startsWith('ss://') ||
      link.startsWith('trojan://') ||
      link.startsWith('tuic://') ||
      link.startsWith('hysteria2://') ||
      link.startsWith('hy2://')
    ) {
      return processOther(link, env, useFlag, useSuffix, useOrg);
    }
    return '';
  }));

  const subContent = tools.base64.encode(processed.filter(l => l).join('\n'));
  return new Response(subContent, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// 处理 vmess 协议
async function processVmess(link, env, useFlag, useSuffix, useOrg) {
  const [prefix, config] = link.split('://');
  const decoded = JSON.parse(tools.base64.decode(config));
  const add = decoded.add;
  if (!add) return link;
  try {
    const { country, org } = await domainORip(add);
    const newName = newNodeName(country, org, env, useFlag, useSuffix, useOrg);
    decoded.ps = newName;
    return `${prefix}://${tools.base64.encode(JSON.stringify(decoded))}`;
  } catch (error) {
    console.error(`处理 vmess 链接 ${link} 时出错:`, error);
    return link;
  }
}

// 处理其他协议
async function processOther(link, env, useFlag, useSuffix, useOrg) {
  const urlObj = new URL(link);
  const ipMatch = urlObj.href.match(/@(\[.*?\]|[^:?]+)/);
  const add = ipMatch ? ipMatch[1] : null;
  if (!add) return link;
  try {
      const { country, org } = await domainORip(add);
      const newName = newNodeName(country, org, env, useFlag, useSuffix, useOrg);
      urlObj.hash = newName;
      return urlObj.toString();
  } catch (error) {
      console.error(`处理链接 ${link} 时出错:`, error);
      return link;
  }
}

// 前端页面生成函数
function frontendPage(env) {
  const bgImg = env.BG_IMG || 'https://raw.githubusercontent.com/yutian81/data-source/main/picbed/vpscheck_beijing.jpg';
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>节点批量格式化</title>
      <style>
      :root {
          --bg: url('${bgImg}') center/cover fixed;
          --card-bg: rgba(255, 255, 255, 0.6);
      }
      body {
        min-height: 100vh;
        background: var(--bg);
        font-family: system-ui;
        margin: 0;
        padding: 20px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
      }
      .container {
        width: 60%;
        max-width: 800px;
        min-width: 320px;
        background: var(--card-bg);
        backdrop-filter: blur(10px);
        border-radius: 12px;
        padding: 20px;
        box-shadow: 0 4px 30px rgba(0,0,0,0.1);
      }
      h1 {
        margin: 10px 0 20px 0;
      }
      textarea#input {
        width: calc(100% - 25px);
        height: 80px;
        margin: 8px 0;
        background: rgba(255,255,255,0.5);
        border: 1px solid rgba(0,0,0,0.2);
        color: #000;
        padding: 10px;
        border-radius: 6px;
        font-size: 14px;
      }
      textarea#output {
        width: calc(100% - 25px);
        height: 150px;
        margin: 8px 0;
        background: rgba(255,255,255,0.5);
        border: 1px solid rgba(0,0,0,0.2);
        color: #000;
        padding: 10px;
        border-radius: 6px;
        font-size: 14px;
      }
      .btn-group {
        display: flex;
        gap: 30px;
        margin: 15px 0;
        align-items: center;
      }
      button {
        background: #007aff;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
      }
      button.copy-btn {
        background: #28a745;
      }
      footer {
        text-align: center;
        color: #aaa;
        font-size: 12px;
        margin-top: 20px;
      }
      footer a {
        text-decoration: none;
        color: #aaa;
      }
      @media (max-width: 600px) {
        body { padding: 10px; }
        .container { width: 90%; border-radius: 8px; }
      }
  </style>
  </head>
  <body>
    <div class="container">
      <h1>节点名称批量格式化</h1>
      <label>请在此填入节点链接或订阅地址</label>
      <textarea placeholder="支持填入节点链接，如 vless://********、vmess://********等\n支持填入订阅地址，如 https://example.com/vless\n支持填入多条节点或订阅，每行一条" id="input"></textarea>
      <div class="btn-group">
        <label><input type="checkbox" id="flag" checked> 显示国旗 Emoji</label>
        <label><input type="checkbox" id="suffix" checked> 显示自定义后缀</label>
        <label><input type="checkbox" id="org"> 显示 ORG 组织</label>
        <button onclick="format()">格式化</button>
        <button class="copy-btn" onclick="copyOutput()">复制结果</button>
      </div>
      <textarea id="output" readonly placeholder="格式化后的结果将显示在这里"></textarea>
    </div>
    <footer>
      Copyright © 2025 Yutian81  |   
      <a href="https://github.com/yutian81/vps-check" target="_blank">GitHub Repository</a>  |  
      <a href="https://blog.811520.xyz/" target="_blank">青云志博客</a>
    </footer>

    <script>
      async function format() {
        const input = document.getElementById('input').value;
        const useFlag = document.getElementById('flag').checked;
        const useSuffix = document.getElementById('suffix').checked;
        const useOrg = document.getElementById('org').checked;
        try {
          const resp = await fetch('/sub/' + encodeURIComponent(input), {
            method: 'POST',
            headers: {
              'X-Flag': useFlag,
              'X-Suffix': useSuffix,
              'X-Org': useOrg
            }
          });
          if (!resp.ok) throw new Error(\`请求失败，状态码: \${resp.status}\`);
          const subContent = await resp.text();
          document.getElementById('output').value = subContent;
        } catch (error) {
            console.error('格式化过程中出现错误:', error);
            document.getElementById('output').value = \`格式化失败: \${error.message}\`;
        }
      }
      function copyOutput() {
        const output = document.getElementById('output');
        output.select();
        document.execCommand('copy');
        alert('结果已复制到剪贴板');
      }
    </script>
  </body>
  </html>
  `;
}
