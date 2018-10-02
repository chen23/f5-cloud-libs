/**
 * Copyright 2017 F5 Networks, Inc.
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
const signals = require('../../lib/signals');
const util = require('util');
const CloudProvider = require('../../lib/cloudProvider');

let fsMock;
let ipcMock;
let utilMock;
let argv;
let cluster;
let realWriteFile;
let realReadFile;

let bigIpMock;
let providerMock;

const testOptions = {};

let functionsCalled;
let sentSignals;

let exitMessage;
let exitCode;

util.inherits(ProviderMock, CloudProvider);
function ProviderMock() {
    ProviderMock.super_.call(this);
    this.functionCalls = {};
}

ProviderMock.prototype.init = function init(...args) {
    this.functionCalls.init = args;
    return q();
};

ProviderMock.prototype.bigIpReady = function bigIpReady(...args) {
    this.functionCalls.bigIpReady = args;
    return q();
};

module.exports = {
    setUp(callback) {
        /* eslint-disable global-require */
        fsMock = require('fs');
        utilMock = require('../../lib/util');
        ipcMock = require('../../lib/ipc');

        utilMock.logAndExit = (message, level, code) => {
            exitMessage = message;
            exitCode = code;
        };
        utilMock.logError = () => { };
        utilMock.saveArgs = () => {
            return q();
        };

        sentSignals = [];

        ipcMock.send = (signal) => {
            sentSignals.push(signal);
        };

        ipcMock.once = (signal) => {
            const deferred = q.defer();
            functionsCalled.ipc.once.push(signal);
            setInterval(() => {
                if (sentSignals.includes(signal)) {
                    deferred.resolve();
                }
            }, 100);
            return deferred.promise;
        };

        bigIpMock = {
            init(...args) {
                functionsCalled.bigIp.init = args;
                return q();
            },

            isBigIp() {
                return true;
            },

            isBigIq() {
                return false;
            },

            list(...args) {
                functionsCalled.bigIp.list = args;
                return q();
            },

            modify(...args) {
                functionsCalled.bigIp.modify = args;
                return q();
            },

            create(...args) {
                functionsCalled.bigIp.create = args;
                return q();
            },

            delete(...args) {
                functionsCalled.bigIp.delete = args;
                return q();
            },

            ready(...args) {
                functionsCalled.bigIp.ready = args;
                return q();
            },

            save(...args) {
                functionsCalled.bigIp.save = args;
                return q();
            },

            active(...args) {
                functionsCalled.bigIp.active = args;
                return q();
            },

            ping(...args) {
                functionsCalled.bigIp.ping = args;
                return q();
            },

            rebootRequired(...args) {
                functionsCalled.bigIp.rebootRequired = args;
                return q(false);
            },

            reboot(...args) {
                functionsCalled.bigIp.reboot = args;
                return q();
            },
            onboard: {
                setRootPassword(...args) {
                    functionsCalled.bigIp.onboard.setRootPassword = args;
                    return q();
                }
            },
            cluster: {
                addSecondary(...args) {
                    functionsCalled.bigIp.cluster.addSecondary = args;
                    return q();
                }
            }
        };

        testOptions.bigIp = bigIpMock;

        realWriteFile = fsMock.writeFile;
        fsMock.writeFile = (file, data, options, cb) => {
            cb();
        };

        functionsCalled = {
            ipc: {
                once: []
            },
            bigIp: {
                onboard: {},
                cluster: {}
            },
            util: {}
        };

        cluster = require('../../scripts/cluster');
        argv = ['node', 'cluster.js', '--log-level', 'none', '--password-url', 'file:///password',
            '-u', 'user', '--host', 'localhost', '--output', 'cluster.log'];

        callback();
    },

    tearDown(callback) {
        utilMock.removeDirectorySync(ipcMock.signalBasePath);
        fsMock.readFile = realReadFile;
        fsMock.writeFile = realWriteFile;

        Object.keys(require.cache).forEach((key) => {
            delete require.cache[key];
        });
        callback();
    },

    testUndefinedOptions: {
        testNoPassword(test) {
            const passwordUrl = 'https://password';
            argv = ['node', 'cluster.js', '--log-level', 'none', '--password-url', passwordUrl,
                '-u', 'user', '--password', '--host', 'localhost', '--output', 'cluster.log'];

            cluster.run(argv, testOptions, () => {
                test.expect(2);
                test.strictEqual(cluster.options.passwordUrl, passwordUrl);
                test.strictEqual(cluster.options.password, undefined);
                test.done();
            });
        },

        testNoPasswordUrl(test) {
            const password = 'password';
            argv = ['node', 'cluster.js', '--log-level', 'none', '--password-url', '-u', 'user',
                '--password', password, '--host', 'localhost', '--output', 'cluster.log'];

            cluster.run(argv, testOptions, () => {
                test.expect(2);
                test.strictEqual(cluster.options.passwordUrl, undefined);
                test.strictEqual(cluster.options.password, password);
                test.done();
            });
        },

        testNoRemotePassword(test) {
            const remotePasswordUrl = 'https://password';
            argv = ['node', 'cluster.js', '--log-level', 'none', '--password', 'password',
                '-u', 'user', '--password', '--host', 'localhost', '--output', 'cluster.log',
                '--remote-password-url', remotePasswordUrl, '--remote-password'];

            cluster.run(argv, testOptions, () => {
                test.expect(2);
                test.strictEqual(cluster.options.remotePasswordUrl, remotePasswordUrl);
                test.strictEqual(cluster.options.remotePassword, undefined);
                test.done();
            });
        },

        testNoRemotePasswordUrl(test) {
            const remotePassword = 'password';
            argv = ['node', 'cluster.js', '--log-level', 'none', '--password-url', '-u', 'user',
                '--password', 'password', '--host', 'localhost', '--output', 'cluster.log',
                '--remote-password-url', '--remote-password', remotePassword];

            cluster.run(argv, testOptions, () => {
                test.expect(2);
                test.strictEqual(cluster.options.remotePasswordUrl, undefined);
                test.strictEqual(cluster.options.remotePassword, remotePassword);
                test.done();
            });
        }
    },

    testWaitFor(test) {
        argv.push('--wait-for', 'foo');
        ipcMock.send('foo');

        test.expect(2);
        cluster.run(argv, testOptions, () => {
            test.deepEqual(sentSignals, ['foo', signals.CLUSTER_RUNNING, signals.CLUSTER_DONE]);
            test.ok(functionsCalled.ipc.once.includes('foo', 'Should wait for foo signal'));
            test.done();
        });
    },

    testExceptionSignalsError(test) {
        bigIpMock.ready = () => {
            return q.reject('err');
        };

        argv.push('--wait-for', 'foo');
        ipcMock.send('foo');

        test.expect(2);
        cluster.run(argv, testOptions, () => {
            test.ok(sentSignals.includes(signals.CLOUD_LIBS_ERROR));
            test.ok(!sentSignals.includes(signals.CLUSTER_DONE, 'runScript should not complete'));
            test.done();
        });
    },

    testBigIqPrimaryRequiredOptions: {
        testNoRootPasswordURI(test) {
            argv.push('--master', '--big-iq-failover-peer-ip', '1.2.3.4');

            test.expect(2);
            cluster.run(argv, testOptions, () => {
                test.notStrictEqual(exitMessage.indexOf('--password-data-uri'), -1);
                test.strictEqual(exitCode, 1);
                test.done();
            });
        }
    },

    testBigIqPasswords: {
        setUp(callback) {
            providerMock = new ProviderMock();
            testOptions.cloudProvider = providerMock;
            callback();
        },

        testRootPasswordSetAsJSON(test) {
            utilMock.readData = (...args) => {
                functionsCalled.util.readData = args;
                return q(JSON.stringify(
                    {
                        rOOt: 'rootPassword'
                    }
                ));
            };

            argv.push('--cloud', 'aws', '--password-data-uri', 'arn:::foo:bar/password');

            test.expect(2);
            cluster.run(argv, testOptions, () => {
                test.deepEqual(functionsCalled.util.readData[0], 'arn:::foo:bar/password');
                test.deepEqual(
                    functionsCalled.bigIp.onboard.setRootPassword,
                    ['rootPassword', undefined, { enableRoot: true }]
                );
                test.done();
            });
        },

        testRootPasswordSetAsText(test) {
            utilMock.readData = (...args) => {
                functionsCalled.util.readData = args;
                return q('rootPassword');
            };

            argv.push('--cloud', 'aws', '--password-data-uri', 'arn:::foo:bar/password');

            test.expect(2);
            cluster.run(argv, testOptions, () => {
                test.deepEqual(functionsCalled.util.readData[0], 'arn:::foo:bar/password');
                test.deepEqual(
                    functionsCalled.bigIp.onboard.setRootPassword,
                    ['rootPassword', undefined, { enableRoot: true }]
                );
                test.done();
            });
        },
    },

    testBigIqCluster: {
        setUp(callback) {
            utilMock.readData = () => {
                return q(JSON.stringify(
                    {
                        rOOt: 'rootPassword'
                    }
                ));
            };
            bigIpMock.isBigIq = () => {
                return true;
            };
            providerMock = new ProviderMock();
            testOptions.cloudProvider = providerMock;

            callback();
        },

        testBigIpClusterAddSeconaryCalled(test) {
            argv.push('--cloud', 'aws', '--password-data-uri', 'arn:::foo:bar/password',
                '--master', '--big-iq-failover-peer-ip', '1.2.3.4');

            bigIpMock.onboard.rootPassword = 'rootpass';
            bigIpMock.password = 'adminpass';

            test.expect(1);
            cluster.run(argv, testOptions, () => {
                test.deepEqual(
                    functionsCalled.bigIp.cluster.addSecondary,
                    ['1.2.3.4', 'user', 'adminpass', 'rootpass']
                );
                test.done();
            });
        },
    },

    testCommon: {
        setUp(callback) {
            callback();
        },

        testSetUserPassword(test) {
            argv.push('--set-user-password');

            test.expect(1);
            cluster.run(argv, testOptions, () => {
                test.deepEqual(functionsCalled.bigIp.init[3], {
                    port: 443,
                    passwordIsUrl: true,
                    passwordEncrypted: undefined,
                    setUserPassword: true
                });
                test.done();
            });
        }
    }
};
