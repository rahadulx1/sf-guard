// sf outputs the parsers are tested against.
//
// ⚠ These are SCHEMA-SHAPED, not captured from a real run. Field names follow the
// plugins' own reporters and schemas (plugin-apex jsonReporter, plugin-deploy-retrieve
// project-deploy-start schema, plugin-org OrgListResult, plugin-limits). Replace each
// with a cleaned real capture (improvement.md, Appendix C) and keep the tests green.
// The org list's field names were checked against `sf org list --json` from
// @salesforce/cli 2.159.7 (values here are made up).

export const ORG_LIST = {
  status: 0,
  result: {
    other: [
      { alias: 'prod', username: 'release@acme.com', isSandbox: false, isScratch: false, isDevHub: false, orgEdition: 'Enterprise Edition', instanceApiVersion: '62.0', accessToken: '[REDACTED]' },
      { alias: 'trial', username: 'trial@acme.com', isSandbox: false, isScratch: false, isDevHub: false, orgEdition: 'Developer Edition', instanceApiVersion: '62.0' },
    ],
    sandboxes: [
      { alias: 'uat', username: 'release@acme.com.uat', isSandbox: true, instanceApiVersion: '61.0' },
      { username: 'dev@acme.com.dev', isSandbox: true, instanceApiVersion: '62.0' },
    ],
    nonScratchOrgs: [{ alias: 'prod', username: 'release@acme.com' }],
    devHubs: [{ alias: 'hub', username: 'hub@acme.com', isDevHub: true, instanceApiVersion: '62.0' }],
    scratchOrgs: [{ alias: 'so', username: 'test-abc@example.com', isScratch: true, expirationDate: '2099-01-01', instanceApiVersion: '62.0' }],
  },
}

export const APEX_PASS = {
  status: 0,
  result: {
    summary: { outcome: 'Passed', testsRan: 2, passing: 2, failing: 0, skipped: 0, passRate: '100%', failRate: '0%', testRunCoverage: '88%', orgWideCoverage: '80%' },
    tests: [
      { Outcome: 'Pass', FullName: 'AccountServiceTest.testInsert', MethodName: 'testInsert' },
      { Outcome: 'Pass', FullName: 'AccountServiceTest.testUpdate', MethodName: 'testUpdate' },
    ],
    coverage: {
      coverage: [
        { name: 'AccountService', totalLines: 25, lines: { 1: 1, 2: 1, 3: 1, 40: 0, 41: 0, 42: 0, 43: 0, 44: 0, 71: 0 }, totalCovered: 22, coveredPercent: 88 },
      ],
    },
  },
}

export const APEX_FAIL = {
  status: 100,
  result: {
    summary: { outcome: 'Failed', testsRan: 3, passing: 2, failing: 1, skipped: 0, passRate: '67%', failRate: '33%', testRunCoverage: '71%' },
    tests: [
      { Outcome: 'Pass', FullName: 'LeadHandlerTest.ok1', MethodName: 'ok1' },
      { Outcome: 'Pass', FullName: 'LeadHandlerTest.ok2', MethodName: 'ok2' },
      {
        Outcome: 'Fail',
        FullName: 'LeadHandlerTest.convertsLead',
        MethodName: 'convertsLead',
        Message: 'System.AssertException: Assertion Failed: Expected: 1, Actual: 0',
        StackTrace: 'Class.LeadHandler.convert: line 34, column 1\nClass.LeadHandlerTest.convertsLead: line 12, column 1',
      },
    ],
    coverage: { coverage: [{ name: 'LeadHandler', totalLines: 10, lines: { 30: 1, 31: 0, 32: 0, 34: 1 }, totalCovered: 7, coveredPercent: 70 }] },
  },
}

export const DEPLOY_OK = {
  status: 0,
  result: { status: 'Succeeded', success: true, checkOnly: true, numberComponentsDeployed: 4, numberComponentErrors: 0, numberTestsCompleted: 2, numberTestErrors: 0, details: { componentFailures: [], runTestResult: { failures: [] } } },
}

export const DEPLOY_FAIL = {
  status: 1,
  result: {
    status: 'Failed',
    success: false,
    numberComponentsDeployed: 1,
    numberComponentErrors: 2,
    numberTestsCompleted: 0,
    numberTestErrors: 0,
    details: {
      componentFailures: [
        { fileName: 'force-app/main/default/classes/AccountService.cls', lineNumber: 34, columnNumber: 12, problem: 'Variable does not exist: foo', problemType: 'Error', componentType: 'ApexClass', fullName: 'AccountService' },
        { fileName: 'force-app/main/default/lwc/card/card.js', lineNumber: 3, columnNumber: 1, problem: 'Unexpected token', problemType: 'Error', componentType: 'LightningComponentBundle', fullName: 'card' },
        { fileName: 'force-app/main/default/classes/Old.cls', problem: 'Deprecated', problemType: 'Warning', componentType: 'ApexClass', fullName: 'Old' },
      ],
      // a single failure is an object, not an array, in the Metadata API's reply
      runTestResult: { failures: { name: 'AccountServiceTest', methodName: 'testInsert', message: 'System.NullPointerException', stackTrace: 'Class.AccountService.sync: line 20, column 1' } },
    },
  },
}

export const LIMITS = {
  status: 0,
  result: [
    { name: 'DailyApiRequests', max: 15000, remaining: 14000 },
    { name: 'DataStorageMB', max: 1000, remaining: 100 },
    { name: 'HourlyODataCallout', max: 20000, remaining: 20000 },
  ],
}

// ⚠ Code Analyzer v5 shape from its docs, not a capture
export const ANALYZER = {
  runDir: '/project',
  violationCounts: { total: 1, sev1: 0, sev2: 1, sev3: 0, sev4: 0, sev5: 0 },
  violations: [
    {
      rule: 'ApexCRUDViolation',
      engine: 'pmd',
      severity: 2,
      tags: ['Recommended', 'Security'],
      primaryLocationIndex: 0,
      locations: [{ file: '/project/force-app/main/default/classes/AccountService.cls', startLine: 12, startColumn: 5 }],
      message: 'Validate CRUD permission before SOQL/DML operation',
    },
  ],
}

export const HUMAN_DEPLOY = 'Deploying v62.0 metadata to release@acme.com.uat using the v62.0 SOAP API.\nStatus: Succeeded\nDeployed Source\n'
