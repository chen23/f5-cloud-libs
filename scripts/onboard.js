/**
 * Copyright 2016-2018 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const q = require('q');
const BigIp = require('../lib/bigIp');
const Logger = require('../lib/logger');
const ActiveError = require('../lib/activeError');
const ipc = require('../lib/ipc');
const signals = require('../lib/signals');
const util = require('../lib/util');
const metricsCollector = require('../lib/metricsCollector');
const commonOptions = require('./commonOptions');
const cloudProviderFactory = require('../lib/cloudProviderFactory');
const localCryptoUtil = require('../lib/localCryptoUtil');
const cryptoUtil = require('../lib/cryptoUtil');

(function run() {
    const runner = {
        /**
         * Runs the onboarding script
         *
         * @param {String[]} argv - The process arguments
         * @param {Object}   testOpts - Options used during testing
         * @param {Object}   testOpts.bigIp - BigIp object to use for testing
         * @param {Function} cb - Optional cb to call when done
         */
        run(argv, testOpts, cb) {
            const DEFAULT_LOG_FILE = '/tmp/onboard.log';
            const ARGS_FILE_ID = `onboard_${Date.now()}`;
            const ARGS_TO_STRIP = ['--wait-for'];

            const KEYS_TO_MASK = [
                '-p',
                '--password',
                '--set-password',
                '--set-root-password',
                '--big-iq-password'
            ];
            const OPTIONS_TO_UNDEFINE = [
                'bigIqPasswordUri',
                'bigIqPassword',
                'metrics',
                'password',
                'passwordUrl',
                'skuKeyword1',
                'skuKeyword2',
                'unitOfMeasure',
                'tenant'
            ];
            const REQUIRED_OPTIONS = ['host'];
            const globalSettings = {};
            const dbVars = {};
            const provisionModules = {};
            const provisionModule = {};
            const rootPasswords = {};
            const updateUsers = [];
            const loggerOptions = {};
            const metrics = {};
            const createRegKeyPool = {};
            const createLicensePool = {};
            const optionsForTest = {};

            const providerOptions = {};

            let loggableArgs;
            let logger;
            let logFileName;
            let bigIp;
            let rebooting;
            let exiting;
            let index;
            let randomUser;

            let provider;
            let bigIqPasswordData;

            Object.assign(optionsForTest, testOpts);

            /**
             * Special case of util.pair. Used to parse root password options in the form of
             *     old:oldRootPassword,new:newRootPassword
             * Since passwords can contain any character, a delimiter is difficult to find.
             * Compromise by looking for ',new:' as a delimeter
             */
            const parseRootPasswords = function (passwordsValue) {
                const set = passwordsValue.split(',new:');

                if (set.length === 2) {
                    rootPasswords.old = set[0].split('old:')[1];
                    rootPasswords.new = set[1];
                }
            };

            /**
             * Control whether to load f5-cloud-libs-{provider} library.
             * There are cases where the cloud name is needed, but a cloud provider is not.
             */
            const shouldLoadProviderLibrary = function (options) {
                return (!!options.signalResource);
            };

            try {
                /* eslint-disable max-len */
                const options = commonOptions.getCommonOptions(DEFAULT_LOG_FILE)
                    .option(
                        '--ntp <ntp_server>',
                        'Set NTP server. For multiple NTP servers, use multiple --ntp entries.',
                        util.collect,
                        []
                    )
                    .option(
                        '--tz <timezone>',
                        'Set timezone for NTP setting.'
                    )
                    .option(
                        '--dns <DNS server>',
                        'Set DNS server. For multiple DNS severs, use multiple --dns entries.',
                        util.collect,
                        []
                    )
                    .option(
                        '--ssl-port <ssl_port>', 'Set the SSL port for the management IP',
                        parseInt
                    )
                    .option(
                        '-l, --license <license_key>',
                        'License device with <license_key>.'
                    )
                    .option(
                        '-a, --add-on <add_on_key>',
                        'License device with <add_on_key>. For multiple keys, use multiple -a entries.',
                        util.collect,
                        []
                    )
                    .option(
                        '--cloud <provider>',
                        'Cloud provider (aws | azure | etc.). This is required if licensing via BIG-IQ 5.4+ is being used, signalling resource provisioned, or providing a primary passphrase'
                    )
                    .option(
                        '--provider-options <cloud_options>',
                        'Options specific to cloud_provider. Ex: param1:value1,param2:value2',
                        util.map,
                        providerOptions
                    )
                    .option(
                        '--license-pool',
                        'License BIG-IP from a BIG-IQ license pool. Supply the following:'
                    )
                    .option(
                        '    --big-iq-host <ip_address or FQDN>',
                        '    IP address or FQDN of BIG-IQ'
                    )
                    .option(
                        '    --big-iq-user <user>',
                        '    BIG-IQ admin user name'
                    )
                    .option(
                        '    --big-iq-password [password]',
                        '    BIG-IQ admin user password.'
                    )
                    .option(
                        '    --big-iq-password-uri [password_uri]',
                        '    URI (file, http(s), arn) to location that contains BIG-IQ admin user password. Use this or --big-iq-password.'
                    )
                    .option(
                        '    --big-iq-password-encrypted',
                        '    Indicates that the BIG-IQ password is encrypted.'
                    )
                    .option(
                        '    --license-pool-name <pool_name>',
                        '    Name of BIG-IQ license pool.'
                    )
                    .option(
                        '    --sku-keyword-1 [sku_keyword_1]',
                        '    skuKeyword1 parameter for CLPv2 licensing. Default none.'
                    )
                    .option(
                        '    --sku-keyword-2 [sku_keyword_2]',
                        '    skuKeyword2 parameter for CLPv2 licensing. Default none.'
                    )
                    .option(
                        '    --unit-of-measure [unit_of_measure]',
                        '    unitOfMeasure parameter for CLPv2 licensing. Default none.'
                    )
                    .option(
                        '    --tenant [tenant]',
                        '    tenant parameter for CLPv2 licensing. Default none.'
                    )
                    .option(
                        '    --big-ip-mgmt-address <big_ip_address>',
                        '    IP address or FQDN of BIG-IP management port. Use this if BIG-IP reports an address not reachable from BIG-IQ.'
                    )
                    .option(
                        '    --big-ip-mgmt-port <big_ip_port>',
                        '    Port for the management address. Use this if the BIG-IP is not reachable from BIG-IQ via the port used in --port'
                    )
                    .option(
                        '    --no-unreachable',
                        '    Do not use the unreachable API even if it is supported by BIG-IQ.'
                    )
                    .option(
                        '    --revoke',
                        '    Request BIG-IQ to revoke this units license rather than granting one.'
                    )
                    .option(
                        '--signal-resource',
                        'Signal cloud provider when BIG-IP has been provisioned.'
                    )
                    .option(
                        '--big-iq-password-data-uri <key_uri>',
                        'URI (arn, url, etc.) to a JSON file containing the BIG-IQ passwords (required keys: admin, root, primarypassphrase)'
                    )
                    .option(
                        '    --big-iq-password-data-encrypted',
                        '    Indicates that the BIG-IQ password data is encrypted (either with encryptDataToFile or generatePassword)'
                    )
                    .option(
                        '-n, --hostname <hostname>',
                        'Set device hostname.'
                    )
                    .option(
                        '-g, --global-setting <name:value>',
                        'Set global setting <name> to <value>. For multiple settings, use multiple -g entries.',
                        util.pair,
                        globalSettings
                    )
                    .option(
                        '-d, --db <name:value>',
                        'Set db variable <name> to <value>. For multiple settings, use multiple -d entries.',
                        util.pair,
                        dbVars
                    )
                    .option(
                        '--set-root-password <old:old_password,new:new_password>',
                        'Set the password for the root user from <old_password> to <new_password>.',
                        parseRootPasswords
                    )
                    .option(
                        '--set-primary-key',
                        'If running on a BIG-IQ, set the primary key with a random passphrase'
                    )
                    .option(
                        '--create-license-pool <name:reg_key>',
                        'If running on a BIG-IQ, create a pool-style license (purchased pool, utility, volume, or FPS) with the name and reg key.',
                        util.pair,
                        createLicensePool
                    )
                    .option(
                        '--create-reg-key-pool <name:reg_key_list>',
                        'If running on a BIG-IQ, create a reg key pool with the given name and reg keys. Reg keys should be comma separated.',
                        util.pair,
                        createRegKeyPool
                    )
                    .option(
                        '--update-user <user:user,password:password,passwordUrl:passwordUrl,role:role,shell:shell>',
                        'Update user password (or password from passwordUrl), or create user with password, role, and shell. Role and shell are only valid on create.',
                        util.mapArray,
                        updateUsers
                    )
                    .option(
                        '-m, --module <name:level>',
                        'Provision module <name> to <level>. For multiple entries, use --modules',
                        util.pair,
                        provisionModule
                    )
                    .option(
                        '--modules <name:level>',
                        'Provision module(s) <name> to <level> (comma-separated list of module:level pairs).',
                        util.map,
                        provisionModules
                    )
                    .option(
                        '--install-ilx-package <package_uri>',
                        'URI (file) of an iControl LX/iApps LX package to install. The package must already exist at this location.',
                        util.collect,
                        []
                    )
                    .option(
                        '--ping [address]',
                        'Do a ping at the end of onboarding to verify that the network is up. Default address is f5.com'
                    )
                    .option(
                        '--update-sigs',
                        'Update ASM signatures'
                    )
                    .option(
                        '--metrics [customerId:unique_id, deploymentId:deployment_id, templateName:template_name, templateVersion:template_version, cloudName:[aws | azure | gce | etc.], region:region, bigIpVersion:big_ip_version, licenseType:[byol | payg]]',
                        'Optional usage metrics to collect. Customer ID should not identify a specific customer.',
                        util.map,
                        metrics
                    )
                    .option(
                        '--force-reboot',
                        'Force a reboot at the end. This may be necessary for certain configurations. Option --force-reboot and --no-reboot cannot be specified simultaneously.'
                    )
                    .parse(argv);
                /* eslint-enable max-len */

                loggerOptions.console = options.console;
                loggerOptions.logLevel = options.logLevel;
                loggerOptions.module = module;

                if (options.output) {
                    loggerOptions.fileName = options.output;
                }

                if (options.errorFile) {
                    loggerOptions.errorFile = options.errorFile;
                }

                logger = Logger.getLogger(loggerOptions);
                ipc.setLoggerOptions(loggerOptions);
                util.setLoggerOptions(loggerOptions);
                metricsCollector.setLoggerOptions(loggerOptions);

                // Remove specific options with no provided value
                OPTIONS_TO_UNDEFINE.forEach((opt) => {
                    if (typeof options[opt] === 'boolean') {
                        logger.debug(`No value set for option ${opt}. Removing option.`);
                        options[opt] = undefined;
                    }
                });

                // Log the input, but don't log passwords
                loggableArgs = argv.slice();
                for (let i = 0; i < loggableArgs.length; i++) {
                    if (KEYS_TO_MASK.indexOf(loggableArgs[i]) !== -1) {
                        loggableArgs[i + 1] = '*******';
                    }
                }
                index = loggableArgs.indexOf('--update-user');
                if (index !== -1) {
                    loggableArgs[index + 1] = loggableArgs[index + 1].replace(/password:([^,])+/, '*******');
                }
                logger.info(`${loggableArgs[1]} called with`, loggableArgs.join(' '));

                for (let i = 0; i < REQUIRED_OPTIONS.length; i++) {
                    if (!options[REQUIRED_OPTIONS[i]]) {
                        const error = `${REQUIRED_OPTIONS[i]} is a required command line option.`;

                        ipc.send(signals.CLOUD_LIBS_ERROR);

                        util.logError(error, loggerOptions);
                        util.logAndExit(error, 'error', 1);
                    }
                }

                if (options.forceReboot && !options.reboot) {
                    const error = 'Option --force-reboot and --no-reboot cannot be specified simultaneously.';

                    ipc.send(signals.CLOUD_LIBS_ERROR);

                    util.logError(error, loggerOptions);
                    util.logAndExit(error, 'error', 1);
                }

                if (options.user && !(options.password || options.passwordUrl)) {
                    const error = 'If specifying --user, --password or --password-url is required.';

                    ipc.send(signals.CLOUD_LIBS_ERROR);

                    util.logError(error, loggerOptions);
                    util.logAndExit(error, 'error', 1);
                }

                // When running in cloud init, we need to exit so that cloud init can complete and
                // allow the device services to start
                if (options.background) {
                    logFileName = options.output || DEFAULT_LOG_FILE;
                    logger.info('Spawning child process to do the work. Output will be in', logFileName);
                    util.runInBackgroundAndExit(process, logFileName);
                }

                // Use hostname if both hostname and global-settings hostname are set
                if (globalSettings && options.hostname) {
                    if (globalSettings.hostname || globalSettings.hostName) {
                        logger.info('Using host-name option to override global-settings hostname');
                        delete globalSettings.hostName;
                        delete globalSettings.hostname;
                    }
                }

                // Check whether a cloud provider is required
                if (options.cloud && shouldLoadProviderLibrary(options)) {
                    provider = optionsForTest.cloudProvider;
                    if (!provider) {
                        provider = cloudProviderFactory.getCloudProvider(
                            options.cloud,
                            {
                                loggerOptions
                            }
                        );
                    }
                }
                // Start processing...

                // Save args in restart script in case we need to reboot to recover from an error
                util.saveArgs(argv, ARGS_FILE_ID)
                    .then(() => {
                        if (options.waitFor) {
                            logger.info('Waiting for', options.waitFor);
                            return ipc.once(options.waitFor);
                        }

                        return q();
                    })
                    .then(() => {
                        // Whatever we're waiting for is done, so don't wait for
                        // that again in case of a reboot
                        return util.saveArgs(argv, ARGS_FILE_ID, ARGS_TO_STRIP);
                    })
                    .then(() => {
                        if (provider) {
                            logger.info('Initializing cloud provider');
                            return provider.init(providerOptions);
                        }
                        return q();
                    })
                    .then(() => {
                        logger.info('Onboard starting.');
                        ipc.send(signals.ONBOARD_RUNNING);

                        // Retrieve, and save, stored password data
                        if (options.bigIqPasswordDataUri) {
                            return util.readData(options.bigIqPasswordDataUri,
                                true,
                                {
                                    clOptions: providerOptions,
                                    logger,
                                    loggerOptions
                                })
                                .then((uriData) => {
                                    if (options.bigIqPasswordDataEncrypted) {
                                        return localCryptoUtil.decryptPassword(uriData);
                                    }
                                    return q(uriData);
                                })
                                .then((uriData) => {
                                    const parsedData = (typeof uriData === 'string')
                                        ? JSON.parse(uriData.trim())
                                        : uriData;
                                    bigIqPasswordData = util.lowerCaseKeys(
                                        parsedData
                                    );
                                })
                                .then(() => {
                                    if (!bigIqPasswordData.admin
                                        || !bigIqPasswordData.root
                                        || !bigIqPasswordData.primarypassphrase
                                    ) {
                                        const msg =
                                            'Required passwords missing from --biq-iq-password-data-uri';
                                        logger.info(msg);
                                        return q.reject(msg);
                                    }
                                    return q();
                                })
                                .catch((err) => {
                                    logger.info('Unable to retrieve JSON from --big-iq-password-data-uri');
                                    return q.reject(err);
                                });
                        }
                        return q();
                    })
                    .then(() => {
                        if (!options.user) {
                            logger.info('Generating temporary user.');
                            return cryptoUtil.nextRandomUser();
                        }

                        return q(
                            {
                                user: options.user,
                                password: options.password || options.passwordUrl
                            }
                        );
                    })
                    .then((credentials) => {
                        randomUser = credentials.user; // we need this info later to delete it

                        // Create the bigIp client object
                        bigIp = optionsForTest.bigIp || new BigIp({ loggerOptions });

                        logger.info('Initializing device.');
                        return bigIp.init(
                            options.host,
                            credentials.user,
                            credentials.password,
                            {
                                port: options.port,
                                passwordIsUrl: typeof options.passwordUrl !== 'undefined',
                                passwordEncrypted: options.passwordEncrypted,
                                clOptions: providerOptions
                            }
                        );
                    })
                    .then(() => {
                        logger.info('Waiting for device to be ready.');
                        return bigIp.ready();
                    })
                    .then(() => {
                        logger.info('Device is ready.');
                        // Set admin password
                        if (options.bigIqPasswordDataUri) {
                            return bigIp.onboard.updateUser('admin', bigIqPasswordData.admin);
                        }
                        return q();
                    })
                    .then(() => {
                        const deferred = q.defer();
                        // Set the PrimaryKey if it's not set, using either a random passphrase or
                        // a passphrase provided via --password-data-uri
                        if (bigIp.isBigIq()) {
                            bigIp.onboard.isPrimaryKeySet()
                                .then((isSet) => {
                                    if (isSet) {
                                        logger.info('Primary key is already set.');
                                        deferred.resolve();
                                    } else if (options.setPrimaryKey) {
                                        logger.info('Setting primary key.');

                                        bigIp.onboard.setRandomPrimaryPassphrase()
                                            .then(() => {
                                                deferred.resolve();
                                            })
                                            .catch((err) => {
                                                logger.info(
                                                    'Unable to set primary key',
                                                    err && err.message ? err.message : err
                                                );
                                                deferred.reject(err);
                                            });
                                    } else if (bigIqPasswordData) {
                                        logger.info('Setting primary passphrase from password data uri');
                                        bigIp.onboard.setPrimaryPassphrase(
                                            bigIqPasswordData.primarypassphrase
                                        )
                                            .then(() => {
                                                deferred.resolve();
                                            })
                                            .catch((err) => {
                                                logger.info(
                                                    'Unable to set primary passphrase',
                                                    err && err.message ? err.message : err
                                                );
                                                deferred.reject(err);
                                            });
                                    }
                                })
                                .catch((err) => {
                                    logger.info(
                                        'Unable to check primary key', err && err.message ? err.message : err
                                    );
                                    deferred.reject(err);
                                });
                        } else {
                            deferred.resolve();
                        }

                        return deferred.promise;
                    })
                    .then(() => {
                        if (options.sslPort) {
                            logger.info('Setting SSL port.');
                            return bigIp.onboard.sslPort(options.sslPort);
                        }

                        return q();
                    })
                    .then((response) => {
                        let portIndex;

                        logger.debug(response);

                        // If we just successfully changed the SSL port, save --port
                        // as an argument in case we reboot
                        if (options.sslPort) {
                            // If there is already a port argument, remove it
                            if (options.port) {
                                portIndex = argv.indexOf('--port');
                                if (portIndex !== -1) {
                                    argv.splice(portIndex, 2);
                                }
                            }
                            argv.push('--port', options.sslPort);
                            return util.saveArgs(argv, ARGS_FILE_ID, ARGS_TO_STRIP);
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        if (Object.keys(rootPasswords).length > 0) {
                            if (!rootPasswords.old || !rootPasswords.new) {
                                return q.reject('Old or new password missing for root user.');
                            }

                            logger.info('Setting rootPassword.');
                            return bigIp.onboard.password('root', rootPasswords.new, rootPasswords.old);
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        if (options.cloud && options.bigIqPasswordDataUri) {
                            logger.info('Setting root password');
                            return bigIp.onboard.setRootPassword(
                                bigIqPasswordData.root,
                                undefined,
                                { enableRoot: true }
                            );
                        }
                        return q();
                    })
                    .then((response) => {
                        const promises = [];

                        logger.debug(response);

                        if (updateUsers.length > 0) {
                            for (let i = 0; i < updateUsers.length; i++) {
                                logger.info('Updating user', updateUsers[i].user);
                                promises.push(bigIp.onboard.updateUser(
                                    updateUsers[i].user,
                                    updateUsers[i].password || updateUsers[i].passwordUrl,
                                    updateUsers[i].role,
                                    updateUsers[i].shell,
                                    {
                                        passwordIsUrl: typeof updateUsers[i].passwordUrl !== 'undefined'
                                    }
                                ));
                            }
                            return q.all(promises);
                        }

                        return q();
                    })
                    .then((response) => {
                        let ntpBody;

                        logger.debug(response);

                        if (options.ntp.length > 0 || options.tz) {
                            logger.info('Setting up NTP.');

                            ntpBody = {};

                            if (options.ntp && options.ntp.length > 0) {
                                ntpBody.servers = options.ntp;
                            }

                            if (options.tz) {
                                ntpBody.timezone = options.tz;
                            }

                            return bigIp.modify(
                                '/tm/sys/ntp',
                                ntpBody
                            );
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        if (options.dns.length > 0) {
                            logger.info('Setting up DNS.');

                            return bigIp.modify(
                                '/tm/sys/dns',
                                {
                                    'name-servers': options.dns
                                }
                            );
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        if (options.hostname) {
                            logger.info('Setting hostname to', options.hostname);
                            return bigIp.onboard.hostname(options.hostname);
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        // BIG-IP and BIG-IQ disable their setup gui differently.
                        // We'll take care of BIG-IQ at the end of onboarding.
                        if (bigIp.isBigIp()) {
                            globalSettings.guiSetup = 'disabled';
                        }

                        if (Object.keys(globalSettings).length > 0) {
                            logger.info('Setting global settings.');
                            return bigIp.onboard.globalSettings(globalSettings);
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        if (Object.keys(dbVars).length > 0) {
                            logger.info('Setting DB vars.');
                            return bigIp.onboard.setDbVars(dbVars);
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        const registrationKey = options.license;
                        const addOnKeys = options.addOn;

                        if (registrationKey || addOnKeys.length > 0) {
                            logger.info('Licensing.');

                            return bigIp.onboard.license(
                                {
                                    registrationKey,
                                    addOnKeys,
                                    overwrite: true
                                }
                            );
                        } else if (options.licensePool) {
                            if (
                                !options.bigIqHost ||
                                !options.bigIqUser ||
                                !(options.bigIqPassword || options.bigIqPasswordUri) ||
                                !options.licensePoolName
                            ) {
                                return q.reject(new Error('Missing parameters for BIG-IQ license pool'));
                            }

                            if (options.revoke) {
                                logger.info('Requesting BIG-IQ to revoke licnse.');
                                return bigIp.onboard.revokeLicenseViaBigIq(
                                    options.bigIqHost,
                                    options.bigIqUser,
                                    options.bigIqPassword || options.bigIqPasswordUri,
                                    options.licensePoolName,
                                    {
                                        passwordIsUri: typeof options.bigIqPasswordUri !== 'undefined',
                                        passwordEncrypted: options.bigIqPasswordEncrypted,
                                        bigIpMgmtAddress: options.bigIpMgmtAddress,
                                        bigIpMgmtPort: options.bigIpMgmtPort,
                                        noUnreachable: !options.unreachable
                                    }
                                );
                            }

                            logger.info('Getting license from BIG-IQ license pool.');
                            return bigIp.onboard.licenseViaBigIq(
                                options.bigIqHost,
                                options.bigIqUser,
                                options.bigIqPassword || options.bigIqPasswordUri,
                                options.licensePoolName,
                                options.cloud,
                                {
                                    passwordIsUri: typeof options.bigIqPasswordUri !== 'undefined',
                                    passwordEncrypted: options.bigIqPasswordEncrypted,
                                    bigIpMgmtAddress: options.bigIpMgmtAddress,
                                    bigIpMgmtPort: options.bigIpMgmtPort,
                                    skuKeyword1: options.skuKeyword1,
                                    skuKeyword2: options.skuKeyword2,
                                    unitOfMeasure: options.unitOfMeasure,
                                    tenant: options.tenant,
                                    noUnreachable: !options.unreachable
                                }
                            );
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        if (Object.keys(provisionModule).length > 0) {
                            logger.info('Provisioning module', provisionModule);
                            return bigIp.onboard.provision(provisionModule);
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        if (Object.keys(provisionModules).length > 0) {
                            logger.info('Provisioning modules', provisionModules);
                            return bigIp.onboard.provision(provisionModules);
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        if (options.updateSigs) {
                            logger.info('Updating ASM signatures');
                            return bigIp.create(
                                '/tm/asm/tasks/update-signatures',
                                {}
                            );
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        const names = Object.keys(createLicensePool);
                        if (names.length > 0 && bigIp.isBigIq()) {
                            const regKey = createLicensePool[names[0]];
                            logger.info('Creating license pool.');
                            return bigIp.onboard.createLicensePool(names[0], regKey);
                        }
                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        const names = Object.keys(createRegKeyPool);
                        if (names.length > 0 && bigIp.isBigIq()) {
                            const regKeyCsv = createRegKeyPool[names[0]];
                            const regKeys = regKeyCsv.split(',');
                            logger.info('Creating reg key pool.');
                            return bigIp.onboard.createRegKeyPool(names[0], regKeys);
                        }
                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);

                        if (options.installIlxPackage) {
                            const packages = options.installIlxPackage;
                            const promises = [];

                            if (packages.length > 0) {
                                packages.forEach((packagePath) => {
                                    promises.push(bigIp.onboard.installIlxPackage(packagePath));
                                });
                                return q.all(promises);
                            }
                        }
                        return q();
                    })
                    .then(() => {
                        // Have installed the ilx package(s); strip out args, including --install-ilx-package
                        ARGS_TO_STRIP.push('--install-ilx-package');
                        return util.saveArgs(argv, ARGS_FILE_ID, ARGS_TO_STRIP);
                    })
                    .then(() => {
                        if (bigIp.isBigIq()) {
                            // Disable the BIG-IQ setup gui. BIG-IP is done
                            // via global settings and is handled with other global
                            // settings above
                            return bigIp.modify(
                                '/shared/system/setup',
                                {
                                    isSystemSetup: true,
                                    isRootPasswordChanged: true,
                                    isAdminPasswordChanged: true
                                }
                            );
                        }
                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);
                        logger.info('Saving config.');
                        return bigIp.save();
                    })
                    .then((response) => {
                        logger.debug(response);
                        logger.info('Waiting for device to be active.');
                        return bigIp.active();
                    })
                    .then((response) => {
                        logger.debug(response);
                        let address;
                        if (options.ping) {
                            address = options.ping === true ? 'f5.com' : options.ping;
                            logger.info('Pinging', address);
                            return bigIp.ping(address);
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);
                        if (Object.keys(metrics).length > 0) {
                            logger.info('Sending metrics');
                            metrics.action = 'onboard';
                            metrics.cloudLibsVersion = options.version();
                            return metricsCollector.upload(metrics);
                        }

                        return q();
                    })
                    .then((response) => {
                        logger.debug(response);
                        logger.info('Device onboard complete.');
                        return bigIp.rebootRequired();
                    })
                    .then((response) => {
                        if (response === true) {
                            logger.warn('Reboot required.');
                            rebooting = true;
                        }
                        if (options.forceReboot) {
                            rebooting = true;
                            // After reboot, we just want to send our done signal,
                            // in case any other scripts are waiting on us. So, modify
                            // the saved args for that
                            const forcedRebootArgsToStrip = util.getArgsToStripDuringForcedReboot(options);
                            return util.saveArgs(argv, ARGS_FILE_ID, forcedRebootArgsToStrip);
                        }

                        return q();
                    })
                    .then(() => {
                        if (rebooting) {
                            logger.info('Rebooting and exiting. Will continue after reboot.');
                            return util.reboot(bigIp, { signalOnly: !options.reboot });
                        }
                        return q();
                    })
                    .then(() => {
                        if (!rebooting && provider && options.signalResource) {
                            logger.info('Signalling provider that instance provisioned.');
                            return provider.signalInstanceProvisioned();
                        }
                        return q();
                    })
                    .catch((err) => {
                        let message;

                        if (!err) {
                            message = 'unknown reason';
                        } else {
                            message = err.message;
                        }

                        if (err) {
                            if (err instanceof ActiveError || err.name === 'ActiveError') {
                                logger.warn('Device active check failed.');
                                rebooting = true;
                                return util.reboot(bigIp, { signalOnly: !options.reboot });
                            }
                        }

                        ipc.send(signals.CLOUD_LIBS_ERROR);

                        const error = `Onboard failed: ${message}`;
                        util.logError(error, loggerOptions);
                        util.logAndExit(error, 'error', 1);

                        exiting = true;
                        return q();
                    })
                    .done((response) => {
                        logger.debug(response);

                        if (!options.user) {
                            logger.info('Deleting temporary user.');
                            util.deleteUser(randomUser);
                        }

                        if ((!rebooting || !options.reboot) && !exiting) {
                            ipc.send(options.signal || signals.ONBOARD_DONE);
                        }

                        if (cb) {
                            cb();
                        }

                        if (!rebooting) {
                            util.deleteArgs(ARGS_FILE_ID);
                            if (!exiting) {
                                util.logAndExit('Onboard finished.');
                            }
                        } else if (!options.reboot) {
                            // If we are rebooting, but we were called with --no-reboot, send signal
                            if (!exiting) {
                                util.logAndExit('Onboard finished. Reboot required but not rebooting.');
                            }
                        } else {
                            util.logAndExit('Onboard finished. Reboot required.');
                        }
                    });

                // If another script has signaled an error, exit, marking ourselves as DONE
                ipc.once(signals.CLOUD_LIBS_ERROR)
                    .then(() => {
                        ipc.send(options.signal || signals.ONBOARD_DONE);
                        util.logAndExit('ERROR signaled from other script. Exiting');
                    });

                // If we reboot due to some other script, exit - otherwise cloud
                // providers won't know we're done. If we forced the reboot ourselves,
                // we will exit when that call completes.
                ipc.once('REBOOT')
                    .then(() => {
                        if (!rebooting) {
                            util.logAndExit('REBOOT signaled. Exiting.');
                        }
                    });
            } catch (err) {
                if (logger) {
                    logger.error('Onbarding error:', err);
                }

                if (cb) {
                    cb();
                }
            }
        }
    };

    module.exports = runner;

    // If we're called from the command line, run
    // This allows for test code to call us as a module
    if (!module.parent) {
        runner.run(process.argv);
    }
}());
