// 可以通过访问 https://项目域名/sub/订阅地址返回已格式化的节点内容
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

  async parseIPInfo(ip) {
    const ipapi = [
      `https://ip.eooce.com/${ip}`,
      `https://ipinfo.io/${ip}/json`
    ];
    for (const url of ipapi) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json();
        let org = data.organization || data.org || '';
        org = org.split(/[-,]/)[0].trim();
        org = org.replace(/^AS\d+\s*/, '');
        return {
          country: data.country_code || data.country || '未知国家',
          org: org || '未知'
        };
      } catch (err) {
        console.error(`请求 ${url} 失败:`, err);
        continue;
      }
    }
    return { country: '未知国家', org: '未知' };
  },

  getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2 || !/^[A-Za-z]{2}$/.test(countryCode)) {
      return '🏳';
    }
    return String.fromCodePoint(...[...countryCode.toUpperCase()].map(c => 127397 + c.charCodeAt(0)));
  }
};

// 公共辅助函数：判断 add 是域名还是 IP 并解析国家和组织信息
async function domainORip(add) {
  let ip;
  if (add && !/^\d+\.\d+\.\d+\.\d+$/.test(add)) {  // 如果是域名，解析为 IP
    const result = await tools.domainToIP(add);
    ip = result.ip;
  } else {
    ip = add;
  }
  const { country, org } = await tools.parseIPInfo(ip);
  return { country, org };
}

// 公共辅助函数：格式化节点名称
function newNodeName(country, org, env, useFlag, useSuffix, useOrg) {
  if (!useFlag && !useSuffix && !useOrg) {
    return country;
  }
  let parts = [];
  if (useFlag) {
    const flag = tools.getFlagEmoji(country);
    if (flag) parts.push(flag);
  }
  parts.push(country);
  if (useOrg) {
    parts.push(org);
  }
  if (useSuffix) {
    parts.push(env.LINK_RENAME || 'MyNode');
  }
  return parts.filter(Boolean).join(' | ');
}

// 订阅处理模块
async function handleSubRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.slice(5); // 去掉 "/sub/"
  const rawlinks = decodeURIComponent(path).split('\n');
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

  // 从请求头获取三个选项，默认均为开启
  const useFlag = request.headers.get('X-Flag') === 'true';
  const useSuffix = request.headers.get('X-Suffix') === 'true';
  const useOrg = request.headers.get('X-Org') === 'true';

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

  // 直接返回格式化后的 Base64 编码内容
  return new Response(subContent, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// 处理 vmess 协议
async function processVmess(link, env, useFlag, useSuffix, useOrg) {
  const [prefix, config] = link.split('://');
  const decoded = JSON.parse(tools.base64.decode(config));
  const add = decoded.add;
  const { country, org } = await domainORip(add);
  const newName = newNodeName(country, org, env, useFlag, useSuffix, useOrg);
  decoded.ps = newName;
  return `${prefix}://${tools.base64.encode(JSON.stringify(decoded))}`;
}

// 处理其他协议
async function processOther(link, env, useFlag, useSuffix, useOrg) {
  const [sub] = link.split('#');
  const addMatch = sub.match(/@([^:]+):/);
  if (!addMatch) return link;
  const add = addMatch[1];
  const { country, org } = await domainORip(add);
  const newName = newNodeName(country, org, env, useFlag, useSuffix, useOrg);
  return sub + `#${newName}`;
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
        display: flex;
        justify-content: center; /* 水平居中 */
        align-items: center; /* 垂直居中 */
        padding: 20px;
      }
      .container {
        width: 60%;
        max-width: 800px; /* 避免在大屏幕上过宽 */
        min-width: 320px; /* 适配小屏 */
        background: var(--card-bg);
        backdrop-filter: blur(10px);
        border-radius: 12px;
        padding: 20px;
        box-shadow: 0 4px 30px rgba(0,0,0,0.1);
      }
      textarea {
        width: calc(100% - 25px);
        height: 100px;
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
        gap: 10px;
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
      <textarea placeholder="每行填写一条" id="input"></textarea>
      
      <div class="btn-group">
        <label><input type="checkbox" id="flag" checked> 显示国旗 Emoji</label>
        <label><input type="checkbox" id="suffix" checked> 显示自定义后缀</label>
        <label><input type="checkbox" id="org"> 显示 ORG 组织</label>
        <button onclick="format()">格式化</button>
      </div>
      
      <label>格式化结果：</label>
      <textarea id="output" readonly></textarea>
    </div>

    <script>
    async function format() {
      const input = document.getElementById('input').value;
      const useFlag = document.getElementById('flag').checked;
      const useSuffix = document.getElementById('suffix').checked;
      const useOrg = document.getElementById('org').checked;

      const resp = await fetch('/sub/' + encodeURIComponent(input), {
        headers: {
          'X-Flag': useFlag,
          'X-Suffix': useSuffix,
          'X-Org': useOrg
        }
      });

      const subContent = await resp.text();
      document.getElementById('output').value = subContent;
    }
    </script>
  </body>
  </html>
  `;
}
