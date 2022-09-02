const packageJson = require('./package.json');
const chalk = require('chalk');
const prompt = require('prompts');
const fetch = require('node-fetch');
const { zip } = require('zip-a-folder');
const fs = require('fs-extra');
const FormData = require('form-data');
const Configstore = require('configstore');
const glob = require('glob');
const vault = new Configstore(packageJson.name, {});

var configJSON = require('require-module')('./vk-hosting-config.json');
var cfg = configJSON || {};
prompt.message = "vk-mini-apps-deploy".grey;
prompt.delimiter = "=>".grey;

const API_HOST = cfg.api_host || 'https://api.vk.com/method/';

const API_VERSION = '5.131';

const CLIENT_VERSION = 2;

const APPLICATION_ENV_DEV = 1;
const APPLICATION_ENV_PRODUCTION = 2;

const CODE_SUCCESS = 200;
const CODE_DEPLOY = 201;
const CODE_SKIP = 202;
const CODE_PUSH_SENT_VIA_PUSH = 203;
const CODE_PUSH_APPROVED = 204;
const CODE_CONFIRM_SENT_VIA_MESSAGE = 205;

const TYPE_SUCCESS = 'success';

const URL_NAMES = {
    DESKTOP_DEV : 'vk_app_desktop_dev_url',
    MOBILE_DEV: 'vk_app_dev_url',
    MOBILE_WEB_DEV: 'vk_mini_app_mvk_dev_url',
    WEB_LEGACY: 'iframe_url',
    WEB: 'iframe_secure_url',
    MOBILE: 'm_iframe_secure_url',
    MOBILE_WEB: 'vk_mini_app_mvk_url',
}

const PLATFORMS = {
    WEB: 'vk.com',
    MOBILE: 'iOS & Android',
    MOBILE_WEB: 'm.vk.com',
};

const TESTING_PLATFORMS = {
    WEB: 'web',
    MOBILE: 'mobile',
    MOBILE_WEB: 'mvk'
};

const URL_NAMES_MAP = {
    [URL_NAMES.DESKTOP_DEV]: PLATFORMS.WEB,
    [URL_NAMES.MOBILE_DEV]: PLATFORMS.MOBILE,
    [URL_NAMES.MOBILE_WEB_DEV]: PLATFORMS.MOBILE_WEB,
    [URL_NAMES.WEB_LEGACY]: PLATFORMS.WEB,
    [URL_NAMES.WEB]: PLATFORMS.WEB,
    [URL_NAMES.MOBILE]: PLATFORMS.MOBILE,
    [URL_NAMES.MOBILE_WEB]: PLATFORMS.MOBILE_WEB,
};

const TESTING_PLATFORM_MAP = {
    [PLATFORMS.WEB]: TESTING_PLATFORMS.WEB,
    [PLATFORMS.MOBILE]: TESTING_PLATFORMS.MOBILE,
    [PLATFORMS.MOBILE_WEB]: TESTING_PLATFORMS.MOBILE_WEB,
};

async function api(method, params) {
    params['v'] = API_VERSION;
    params['access_token'] = cfg.access_token;
    params['cli_version'] = CLIENT_VERSION;

    if (!cfg.access_token) {
        console.error('access_token is missing');
        return false;
    }

    const queryParams = Object.keys(params).map((k) => { return k + "=" + encodeURIComponent(params[k]) }).join('&');
    try {
        const query = await fetch(API_HOST + method + '?' + queryParams);
        const res = await query.json();
        if (res.error !== void 0) {
            throw new Error(chalk.red(res.error.error_code + ': ' + res.error.error_msg));
        }

        if (res.response !== void 0) {
            return res.response;
        }
    } catch (e) {
        console.error(e);
    }
}

async function getTestingGroups() {
    return await api('apps.getTestingGroups', {});
}

async function updateTestingGroup(webviewUrl, platforms, name, groupId = null) {
    const params = {
        webview: webviewUrl,
        platforms: platforms.join(','),
        name: name
    };

    if (groupId) {
        params.group_id = groupId;
    }

    return await api('apps.updateMetaForTestingGroup', params);
}

async function updateOrCreateTestingGroup(webviewUrl, platforms, name) {
    const groups = await getTestingGroups();
    let groupId = null;

    for (const groupsKey in groups) {
        const group = groups[groupsKey];

        if (group.name === name) {
            groupId = group.group_id;
            break;
        }
    }

    await updateTestingGroup(webviewUrl, platforms, name, groupId);
}

async function upload(uploadUrl, bundleFile) {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(bundleFile), {contentType: 'application/zip'});
    try {
        const upload = await fetch(uploadUrl, {
            method: 'POST',
            headers: formData.getHeaders(),
            body: formData
        });
        return await upload.json();
    } catch (e) {
        console.error('upload error', e);
    }
}

let endpointUrl = null;
let endpoints = [];

async function handleQueue(user_id, base_url, key, ts, version, handled) {
    const url = base_url + '?act=a_check&key=' + key + '&ts=' + ts + '&id=' + user_id + '&wait=5';
    const query = await fetch(url);
    const res = await query.json();

    const ciUrls = !!process.env.CI_URLS;

    if (handled === false) {
        handled = {
            dev: false,
        };
    }

    if (handled.dev) {
        return true;
    }

    if (res.events !== void 0 && res.events.length) {
        for (let i = 0; i < res.events.length; i++) {
            let event = res.events[i].data;
            if (event.type === 'error') {
                const message = event.message || '';
                console.error(chalk.red('Deploy failed, error code: #' + event.code + ' ' + message));
                return false;
            }

            if (event.type === TYPE_SUCCESS) {
                if (event.code === CODE_SUCCESS) {
                    console.info(chalk.green('Deploy success...'));
                    continue;
                }


                if (event.code === CODE_SKIP) {
                    switch (event.message.environment) {
                        case APPLICATION_ENV_DEV:
                            handled.dev = true;
                            break;
                    }
                    continue;
                }

                if (event.code === CODE_DEPLOY) {
                    if (event.message && event.message.urls && Object.keys(event.message.urls).length) {
                        const urls = event.message.urls;

                        if (!event.message.is_production && !handled.dev) {
                            handled.dev = true;
                            console.info(chalk.green('URLs changed for dev:'));
                        }

                        let urlKeys = Object.keys(urls);

                        endpointUrl = urls[urlKeys[0]];


                        for (let j = 0; j < urlKeys.length; j++) {
                            if (urlKeys[j] === URL_NAMES.WEB_LEGACY) {
                                continue;
                            }

                            let prefix = null;
                            if (ciUrls) {
                                prefix = urlKeys[j];
                            } else {
                                prefix = URL_NAMES_MAP[urlKeys[j]];
                            }

                            if (prefix) {
                                prefix += ':\t';
                            } else {
                                prefix = '';
                            }

                            console.log(prefix + urls[urlKeys[j]]);

                            endpoints.push(TESTING_PLATFORM_MAP[URL_NAMES_MAP[urlKeys[j]]])
                        }
                    }
                }
            }
        }
    }

    return handleQueue(user_id, base_url, key, res.ts, version, handled);
}

async function getQueue(version) {
    const r = await api('apps.subscribeToHostingQueue', {app_id: cfg.app_id, version: version});
    if (!r.base_url || !r.key || !r.ts || !r.app_id) {
        throw new Error(JSON.stringify(r));
    }

    return handleQueue(r.app_id, r.base_url, r.key, r.ts, version, false);
}

async function run(cfg, branchName) {

    if (!configJSON) {
        throw new Error('For deploy you need to create config file "vk-hosting-config.json"');
    }

    try {
        const staticPath = cfg.static_path || cfg.staticpath;

        const environment = APPLICATION_ENV_DEV;

        if (process.env.MINI_APPS_ACCESS_TOKEN) {
            cfg.access_token = process.env.MINI_APPS_ACCESS_TOKEN;
        }

        if (!cfg.access_token) {
            throw new Error('env MINI_APPS_ACCESS_TOKEN is not provided');
        }

        if (process.env.MINI_APPS_APP_ID) {
            const appId = parseInt(process.env.MINI_APPS_APP_ID, 10);
            if (isNaN(appId)) {
                throw new Error('env MINI_APPS_APP_ID is not valid number');
            }
            cfg.app_id = appId;
        }

        if (!cfg.app_id) {
            throw new Error('Please provide "app_id" to vk-hosting-config.json or env MINI_APPS_APP_ID');
        }

        const params = {app_id: cfg.app_id, environment: environment};
        const endpointPlatformKeys = Object.keys(cfg.endpoints);
        if (endpointPlatformKeys.length) {
            for (let i = 0; i < endpointPlatformKeys.length; i++) {
                let endpoint = cfg.endpoints[endpointPlatformKeys[i]];
                let fileName = new URL(`/${endpoint}`, 'https://.').pathname;
                let filePath = './' + staticPath + fileName;

                if (!fs.existsSync(filePath)) {
                    throw new Error('File ' + filePath + ' not found');
                }
                params['endpoint_' + endpointPlatformKeys[i]] = endpoint;
            }
        }

        const r = await api('apps.getBundleUploadServer', params);
        if (!r || !r.upload_url) {
            throw new Error(JSON.stringify('upload_url is undefined', r));
        }

        const uploadURL = r.upload_url;
        const bundleFile = cfg.bundleFile || './build.zip';

        if (!cfg.bundleFile) {
            const excludedFiles = await glob.sync('./' + staticPath + '/**/*.txt');

            await excludedFiles.forEach((file) => {
                fs.removeSync(file);
            });

            if (await fs.pathExists(bundleFile)) {
                fs.removeSync(bundleFile)
            }


            await zip('./' + staticPath, bundleFile);
        }

        if (!fs.pathExists(bundleFile)) {
            console.error('Empty bundle file: ' + bundleFile);
            return false;
        }

        const res = await upload(uploadURL, bundleFile).then((r) => {
            if (r.version) {
                console.log('Uploaded version ' + r.version + '!');
                return getQueue(r.version);
            } else {
                console.error('Upload error:', r)
            }
        });

        if (res) {
            try {
                await updateOrCreateTestingGroup(endpointUrl, endpoints, branchName);

                console.log(chalk.green(`Testing group ${branchName} updated`));

                return true;
            } catch (e) {
                console.error(chalk.red(e));
                process.exit(1);
            }
        } else {
            console.error(chalk.red('upload error'));
            process.exit(1);
        }

    } catch (e) {
        console.error(chalk.red(e));
        process.exit(1);
    }
}

module.exports = {
    run: run
};
