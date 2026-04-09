/*
顺丰速运修正版（基于 CHERWING SFSY.py 的签到/日常任务接口重写）
用途：替代 Kefat/Scripts/main/Crack/sfky.js 中失效的“每日签到”逻辑
说明：
1. 保留“抓包保存链接 + 定时执行”的使用方式
2. 重点修复：每日签到、签到任务、领取任务奖励
3. 不包含会员日/采蜜等扩展功能，先保证签到主流程稳定

[Script]
http-response ^https:\/\/mcs-mimp-web\.sf-express\.com\/mcs-mimp\/share\/(weChat\/shareGiftReceiveRedirect|app\/shareRedirect).+ script-path=YOUR_PATH/sfky_fixed.js, requires-body=true, timeout=60, tag=顺丰速运获取token

[MITM]
hostname = mcs-mimp-web.sf-express.com
*/

const $ = new Env('顺丰速运-修正版');
const STORAGE_KEY = 'sfsy_url';
const LEGACY_KEY = 'sfky_url';
const SKIP_TITLES = ['用行业模板寄件下单', '去新增一个收件偏好', '参与积分活动'];

// ===== 入口 =====
(async () => {
  try {
    if (typeof $request !== 'undefined') {
      await captureLink();
    } else {
      await main();
    }
  } catch (e) {
    $.logErr(e);
  } finally {
    $.done();
  }
})();

async function captureLink() {
  const url = ($request && $request.url) || '';
  if (!url || !/shareGiftReceiveRedirect|shareRedirect/.test(url)) {
    $.msg($.name, '抓取失败', '未匹配到顺丰积分页链接');
    return;
  }
  $.setdata(url, STORAGE_KEY);
  $.setdata(url, LEGACY_KEY);
  $.msg($.name, '抓取成功', '已保存顺丰积分页链接，可执行定时任务');
}

async function main() {
  const raw = $.getdata(STORAGE_KEY) || $.getdata(LEGACY_KEY);
  if (!raw) {
    $.msg($.name, '未找到链接', '请先在 QX 中打开顺丰“我的-积分”页面完成抓取');
    return;
  }

  const account = parseCapturedUrl(raw);
  if (!account) {
    $.msg($.name, '链接解析失败', '请重新抓取顺丰积分页链接');
    return;
  }

  $.log(`账号环境：channel=${account.channel}, token=${mask(account.token)}, userId=${mask(account.userId)}`);

  const baseHeaders = buildHeaders(account);

  const state = await queryTasks(account, baseHeaders);
  if (!state) {
    $.msg($.name, '查询失败', '任务/签到列表拉取失败，请重新抓包');
    return;
  }

  let messages = [];

  // 1) 每日签到
  const signRes = await doSign(account, baseHeaders);
  if (signRes) messages.push(signRes);

  // 2) 再查一次，拿最新任务状态
  const latest = await queryTasks(account, baseHeaders);
  const taskList = normalizeTaskList(latest);

  // 3) 处理日常任务
  for (const task of taskList) {
    const title = task.taskName || task.title || '';
    const taskCode = task.taskCode || task.code || task.id;
    const status = String(task.status ?? task.taskStatus ?? '');
    const canDo = ['1', '2', 'PENDING', 'TODO', 'TO_DO'].includes(status) || task.canReceiveStatus === 1;
    const canClaim = ['3', 'FINISHED', 'DONE'].includes(status) || task.fetchStatus === 1 || task.canFetchIntegral;

    if (!title || !taskCode) continue;
    if (SKIP_TITLES.some(x => title.includes(x))) {
      messages.push(`跳过任务：${title}`);
      continue;
    }

    if (canDo) {
      const finishMsg = await finishTask(account, baseHeaders, task);
      if (finishMsg) messages.push(finishMsg);
      await $.wait(800);
    }

    const rewardMsg = await fetchReward(account, baseHeaders, task);
    if (rewardMsg) messages.push(rewardMsg);
    await $.wait(500);
  }

  // 4) 最后汇总积分信息
  const finalState = await queryTasks(account, baseHeaders);
  const point = extractPoint(finalState);
  if (point !== '') messages.push(`当前积分：${point}`);

  $.msg($.name, '执行完成', messages.join('\n') || '无可执行内容');
}

function parseCapturedUrl(raw) {
  try {
    const u = new URL(raw);
    const p = u.searchParams;

    let token = p.get('token') || p.get('accessToken') || p.get('jwt') || p.get('sessionId') || '';
    let userId = p.get('userId') || p.get('memberId') || p.get('mobile') || p.get('phone') || '';
    let channel = 'MINI_PROGRAM';

    if (/\/app\//.test(raw)) channel = 'APP';
    if (/\/weChat\//.test(raw)) channel = 'MINI_PROGRAM';

    if (!token) {
      const match = raw.match(/[?&](token|accessToken|jwt|sessionId)=([^&#]+)/i);
      if (match) token = decodeURIComponent(match[2]);
    }
    if (!userId) {
      const match = raw.match(/[?&](userId|memberId|mobile|phone)=([^&#]+)/i);
      if (match) userId = decodeURIComponent(match[2]);
    }

    return { raw, origin: `${u.protocol}//${u.host}`, token, userId, channel, urlObj: u };
  } catch (e) {
    $.logErr(e);
    return null;
  }
}

function buildHeaders(account) {
  return {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': 'https://mcs-mimp-web.sf-express.com',
    'Referer': account.raw,
    'channel': account.channel,
    'token': account.token || '',
    'sysCode': 'MCS-MIMP-CORE',
  };
}

async function queryTasks(account, headers) {
  const body = {
    from: 'POINT_MALL',
    channelType: account.channel,
    taskCode: '',
  };
  return await requestJson({
    url: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/memberEs/taskRecord/queryPointTaskAndSignFromES',
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function doSign(account, headers) {
  const res = await requestJson({
    url: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/memberEs/sign/automaticSignFetchPackage',
    method: 'POST',
    headers,
    body: JSON.stringify({ channelType: account.channel }),
  });

  if (!res) return '签到失败：接口无返回';

  const success = isSuccess(res);
  const msg = getMsg(res);
  const point = res?.obj?.integral || res?.obj?.point || res?.obj?.count || '';

  if (success) return `每日签到：成功${point !== '' ? `，获得${point}积分` : ''}`;
  if (/已签到|重复|already/i.test(msg)) return '每日签到：今天已签';
  return `每日签到：失败${msg ? `（${msg}）` : ''}`;
}

async function finishTask(account, headers, task) {
  const title = task.taskName || task.title || '未知任务';
  const taskCode = task.taskCode || task.code || task.id;
  const res = await requestJson({
    url: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/memberEs/taskRecord/finishTask',
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskCode,
      channelType: account.channel,
    }),
  });

  if (!res) return `完成任务失败：${title}（接口无返回）`;
  const success = isSuccess(res);
  const msg = getMsg(res);
  if (success || /已完成|already/i.test(msg)) return `完成任务：${title}`;
  return `完成任务失败：${title}${msg ? `（${msg}）` : ''}`;
}

async function fetchReward(account, headers, task) {
  const title = task.taskName || task.title || '未知任务';
  const taskCode = task.taskCode || task.code || task.id;
  const res = await requestJson({
    url: 'https://mcs-mimp-web.sf-express.com/mcs-mimp/memberEs/taskRecord/fetchIntegral',
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskCode,
      channelType: account.channel,
    }),
  });

  if (!res) return '';

  const success = isSuccess(res);
  const msg = getMsg(res);
  const point = res?.obj?.integral || res?.obj?.point || res?.obj?.count || task.integral || task.reward || '';

  if (success) return `领取奖励：${title}${point !== '' ? `（${point}积分）` : ''}`;
  if (/已领取|不可领取|未完成|already/i.test(msg)) return '';
  return `领取奖励失败：${title}${msg ? `（${msg}）` : ''}`;
}

function normalizeTaskList(data) {
  const obj = data?.obj || data?.data || {};
  const candidates = [
    obj.taskList,
    obj.dailyTaskList,
    obj.list,
    obj.integralTaskList,
    obj.page?.records,
    data?.taskList,
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

function extractPoint(data) {
  const obj = data?.obj || data?.data || {};
  return obj.availablePoints ?? obj.point ?? obj.totalPoint ?? obj.usablePoint ?? '';
}

function isSuccess(res) {
  const code = String(res?.success ?? res?.code ?? res?.status ?? '');
  return res?.success === true || ['0', '200', '20000', 'S200', 'SUCCESS'].includes(code.toUpperCase());
}

function getMsg(res) {
  return res?.errorMessage || res?.msg || res?.message || res?.errorMsg || '';
}

function mask(str) {
  if (!str) return '';
  if (str.length <= 8) return str;
  return `${str.slice(0, 4)}****${str.slice(-4)}`;
}

async function requestJson(options) {
  return new Promise((resolve) => {
    $.post(options, (err, resp, data) => {
      if (err) {
        $.log(`请求失败：${JSON.stringify(err)}`);
        resolve(null);
        return;
      }
      try {
        const json = typeof data === 'string' ? JSON.parse(data) : data;
        resolve(json);
      } catch (e) {
        $.log(`解析失败：${data}`);
        resolve(null);
      }
    });
  });
}

function Env(name) {
  return new (class {
    constructor(name) {
      this.name = name;
      this.startTime = new Date().getTime();
      this.logs = [];
    }
    getdata(key) {
      return $prefs.valueForKey(key);
    }
    setdata(val, key) {
      return $prefs.setValueForKey(val, key);
    }
    msg(title, subt, desc) {
      $notify(title, subt, desc);
    }
    log(...args) {
      console.log(args.join(' '));
    }
    logErr(err) {
      console.log(`${this.name}, 错误!`, err);
    }
    wait(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }
    post(opts, cb) {
      $task.fetch({
        url: opts.url,
        method: opts.method || 'POST',
        headers: opts.headers,
        body: opts.body,
      }).then(
        (resp) => cb(null, resp, resp.body),
        (reason) => cb(reason.error || reason, null, null)
      );
    }
    done() {}
  })(name);
}
