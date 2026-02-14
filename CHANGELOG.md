# Changelog

## [0.9.1](https://github.com/theory-cloud/AppTheory/compare/v0.9.0...v0.9.1) (2026-02-14)


### Bug Fixes

* **ci:** pin golangci-lint v2.9.0 ([b40d132](https://github.com/theory-cloud/AppTheory/commit/b40d1322ffdadb9dfd43513ccc36fc4d914efa81))

## [0.9.0](https://github.com/theory-cloud/AppTheory/compare/v0.8.0...v0.9.0) (2026-02-14)


### Features

* **cdk:** FaceTheory SSR site options ([d9435ec](https://github.com/theory-cloud/AppTheory/commit/d9435ec0eb4da63125d927c05cf1511a2d6a15ea))
* **cdk:** FaceTheory SSR site options ([294be15](https://github.com/theory-cloud/AppTheory/commit/294be15b4ba0a06cebd060d5e6f8946092387ba0))


### Bug Fixes

* **pkg:** reuse empty marker constant ([847e7b5](https://github.com/theory-cloud/AppTheory/commit/847e7b5cf3b51048b6edfdfab80c25328f4e0c66))

## [0.8.0-rc.1](https://github.com/theory-cloud/AppTheory/compare/v0.8.0-rc.0...v0.8.0-rc.1) (2026-02-14)


### Features

* add global logger singleton ([d7a8996](https://github.com/theory-cloud/AppTheory/commit/d7a89965dd3316ebfc65a0b3e0b29a599b37537d))
* add portable AppTheoryError type ([340a049](https://github.com/theory-cloud/AppTheory/commit/340a049b292054b53a44f5e59ca9863b77453499))
* **cdk:** add DeletionProtection support to AppTheoryDynamoTable (M3) ([f81db79](https://github.com/theory-cloud/AppTheory/commit/f81db79ebf9d9f98c352e9f6a645a1f87f7fba79))
* **cdk:** add DynamoTable + websocket parity ([a243db3](https://github.com/theory-cloud/AppTheory/commit/a243db3f93f5dbe29af88104a4ad38e0e0dcc381))
* **cdk:** add stream mapping tuning + ws route handlers ([756314f](https://github.com/theory-cloud/AppTheory/commit/756314f77b8fc8b8da37d14b2815d76cfc9cbf3e))
* **cdk:** close Lift CDK parity gaps (issue [#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([beec62b](https://github.com/theory-cloud/AppTheory/commit/beec62b4bbc358f01c1d9cc3207282f5ee89d348))
* **cdk:** close lift parity gaps ([#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([72d4451](https://github.com/theory-cloud/AppTheory/commit/72d44515a7cdce8d74db36f10825df13969e03b4))
* **cdk:** close lift parity gaps ([#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([2e7b719](https://github.com/theory-cloud/AppTheory/commit/2e7b719d7d07949d7b2c2543ccf1fd3f30d9c4a9))
* **cdk:** FaceTheory SSR site options ([d9435ec](https://github.com/theory-cloud/AppTheory/commit/d9435ec0eb4da63125d927c05cf1511a2d6a15ea))
* **cdk:** FaceTheory SSR site options ([294be15](https://github.com/theory-cloud/AppTheory/commit/294be15b4ba0a06cebd060d5e6f8946092387ba0))
* **cdk:** implement AppTheoryLambdaRole construct (M5) ([6eee048](https://github.com/theory-cloud/AppTheory/commit/6eee048c90e92daa1ad126050a0736d167f1e96c))
* **cdk:** implement AppTheoryMediaCdn construct (M4B) ([c87afc6](https://github.com/theory-cloud/AppTheory/commit/c87afc6a4a4e30ad05c6d2339edf2f32215824bf))
* **cdk:** implement AppTheoryPathRoutedFrontend (M4A) ([7a08876](https://github.com/theory-cloud/AppTheory/commit/7a088762985707f3871cc95244814e9e582699d7))
* **cdk:** implement AppTheoryRestApiRouter for M1 (SR-CDK-LIFT-SUNSET) ([f5eb28b](https://github.com/theory-cloud/AppTheory/commit/f5eb28b76da505005fc780661fe9080656611602))
* **cdk:** implement M2 - SQS queue + DLQ + optional consumer wiring ([8a46a88](https://github.com/theory-cloud/AppTheory/commit/8a46a88ba382596b0c5915a33b5f16bbd5b63fa5))
* **cdk:** implement M6 - Lesser parity example + migration validation gate ([038b73e](https://github.com/theory-cloud/AppTheory/commit/038b73ecb2a38c388019c12858199a219118f92b))
* **cdk:** Lift parity (WebSocket + DynamoDB tables) ([b1b3c66](https://github.com/theory-cloud/AppTheory/commit/b1b3c6666f75d51faa7306e19f4ce306c2ffdb24))
* **cdk:** stream mapping tuning + websocket route handlers ([fd310a5](https://github.com/theory-cloud/AppTheory/commit/fd310a57cb76d028bcf8fddb8d24bb2a2c4194ef))
* lift compat helpers + typed JSON handler ([1244cb5](https://github.com/theory-cloud/AppTheory/commit/1244cb5b9c23aa61786274db3d6c71a2830a2aee))
* lift error and logger parity ([5f1185d](https://github.com/theory-cloud/AppTheory/commit/5f1185da3afc0cb70f45a2cb19eb6f00db8def84))
* Parse API origin URL to include originPath for CloudFront HttpOrigin ([e357995](https://github.com/theory-cloud/AppTheory/commit/e357995deb88bc94379fd32ab1b73d78e241440f))
* **runtime:** add typed JSON handler helper ([14d9cf6](https://github.com/theory-cloud/AppTheory/commit/14d9cf691da443f9cc6af30dce8c805dec82ac4c))
* **sanitization:** add mask helpers in ts/py ([1548c7b](https://github.com/theory-cloud/AppTheory/commit/1548c7b1e523a1213087e14e45c1029ff2a2c68f))
* **sanitization:** add MaskFirstLast helpers ([912a607](https://github.com/theory-cloud/AppTheory/commit/912a60746bc9f919f0f6eb07a377f8300fe42785))
* serialize AppTheoryError fields in responses ([3031659](https://github.com/theory-cloud/AppTheory/commit/30316598a5b910dcecb941ad66bb67ad835b3068))
* TableTheory v1.2.1 + hard drift prevention ([d89b679](https://github.com/theory-cloud/AppTheory/commit/d89b67921649b4cff7d95c69304ce8b58558f791))
* **zap:** accept legacy sns topic env var ([2eca449](https://github.com/theory-cloud/AppTheory/commit/2eca449f89e5e1dc9c5e9776333586d786df2b08))


### Bug Fixes

* address issue [#20](https://github.com/theory-cloud/AppTheory/issues/20) (TS batch fail-closed, strict base64, ts pack rebuild) ([99580b7](https://github.com/theory-cloud/AppTheory/commit/99580b728f2ac406093c5d2a6dd59033ff9c7692))
* address issue [#22](https://github.com/theory-cloud/AppTheory/issues/22) followups ([b1e0422](https://github.com/theory-cloud/AppTheory/commit/b1e0422b469955f8fa14e7d4efb3951f1bb84582))
* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([06f3434](https://github.com/theory-cloud/AppTheory/commit/06f3434e2a80317832f150c28b1426a844c91d31))
* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([b794697](https://github.com/theory-cloud/AppTheory/commit/b794697d5b1db95797058bb4b451c72bc5e550de))
* **cdk-go:** publish bindings via root module ([93d30a0](https://github.com/theory-cloud/AppTheory/commit/93d30a0263856723f6286f9e1df9ea88d747be4b))
* **cdk-go:** publish bindings via root module ([9646f88](https://github.com/theory-cloud/AppTheory/commit/9646f88293f530d104b7921a3994b60a831ce587))
* **cdk-go:** regenerate bindings for new constructs ([ed38899](https://github.com/theory-cloud/AppTheory/commit/ed38899a22d1ad8a95cc95633e37e904ec04c238))
* **cdk-go:** regenerate bindings for new constructs ([e25ad1c](https://github.com/theory-cloud/AppTheory/commit/e25ad1c3dfb57519586331955a732c20f73e650d))
* **cdk:** make DynamoTable TTL optional ([3c789fd](https://github.com/theory-cloud/AppTheory/commit/3c789fd1dee87f4076cbe86855c50bfcaa706f8d))
* **cdk:** make DynamoTable TTL optional ([e9b5bf1](https://github.com/theory-cloud/AppTheory/commit/e9b5bf13390eb11bac18d1285105ec3c722a8b22))
* **ci:** allow release-pr CLI ([aeb4a32](https://github.com/theory-cloud/AppTheory/commit/aeb4a32ff31d6670b5eccd8f51ca717d8cde561c))
* **ci:** auto-clean failed prerelease drafts ([4965915](https://github.com/theory-cloud/AppTheory/commit/4965915a0db4711fbe98711910b7efb107d7b2d7))
* **ci:** honor main release-as ([8c49083](https://github.com/theory-cloud/AppTheory/commit/8c4908369a4328c83e3127dfb3dd5ca71a47fbac))
* **ci:** honor main release-as ([27fe861](https://github.com/theory-cloud/AppTheory/commit/27fe861b2b204289365bc9f6d88b5472ae5e8839))
* **ci:** make jsii-pacmak compatible with -rc tags ([fd7e341](https://github.com/theory-cloud/AppTheory/commit/fd7e341a5d485b4877dcff4f77150a3db03b40c3))
* **ci:** make jsii-pacmak compatible with -rc tags ([abed83d](https://github.com/theory-cloud/AppTheory/commit/abed83d26f9c4143b3dccae3c49a89ea2e350ad8))
* **ci:** repair release-pr workflow yaml ([9ce5d80](https://github.com/theory-cloud/AppTheory/commit/9ce5d803733aeced05603df51cb6cb2a885d6ad8))
* **ci:** repair release-pr workflow yaml ([877ca72](https://github.com/theory-cloud/AppTheory/commit/877ca726c013fdecef106b643f2edbe8695db1cd))
* **ci:** run CI on staging pushes ([d218268](https://github.com/theory-cloud/AppTheory/commit/d218268f8915d8032205687306861e89d8b552fe))
* **ci:** run CI on staging pushes ([c3b6ce3](https://github.com/theory-cloud/AppTheory/commit/c3b6ce30172c827a7de02fdcd7a7cfeddcafe9c7))
* **ci:** skip branch version sync outside git repo ([24f59b4](https://github.com/theory-cloud/AppTheory/commit/24f59b4c2e2bcf9ede8739117bbbaec4f720c238))
* **ci:** skip branch version sync outside git repo ([3dd7f81](https://github.com/theory-cloud/AppTheory/commit/3dd7f81484f36a0516fa188b70fbc017faedc749))
* **ci:** support X.Y.Z-rc prerelease versions ([91c8d4c](https://github.com/theory-cloud/AppTheory/commit/91c8d4ce8290e88a18269ca1d00126dfd71190ae))
* **ci:** support X.Y.Z-rc prerelease versions ([9a6abf8](https://github.com/theory-cloud/AppTheory/commit/9a6abf881d6e292b03e46f96fff42cd33a7279d1))
* close TS fail-open + strict base64 ([4d55231](https://github.com/theory-cloud/AppTheory/commit/4d552313c5c657a604962f89e8057ea673146090))
* **contract-tests:** deflake streaming headers fixture ([042cc71](https://github.com/theory-cloud/AppTheory/commit/042cc71705fbeebf62e986292526ecf94b8a2862))
* **contract-tests:** deflake streaming headers fixture ([50a5fda](https://github.com/theory-cloud/AppTheory/commit/50a5fda3e1c2e49eda3fd8c099991d171d7becd1))
* ensure pip is installed in virtual environments and skip symlinks when setting file timestamps. ([f244777](https://github.com/theory-cloud/AppTheory/commit/f24477740e35fd75ebc6d83027943ea801e1f6d9))
* follow-ups from review (issue [#22](https://github.com/theory-cloud/AppTheory/issues/22)) ([4baa42d](https://github.com/theory-cloud/AppTheory/commit/4baa42dafc6b0f9779f2fa8f2d8fc5a9d08b266d))
* **go-lint:** deflake prerelease by removing goconst warning ([c824b9d](https://github.com/theory-cloud/AppTheory/commit/c824b9d0127e5f88257af5f078e8aab5dd087511))
* **go-lint:** unblock prerelease build ([7f640fb](https://github.com/theory-cloud/AppTheory/commit/7f640fbd8b89967d17b5d73bf8e84ed592236626))
* **pkg:** reuse empty marker constant ([847e7b5](https://github.com/theory-cloud/AppTheory/commit/847e7b5cf3b51048b6edfdfab80c25328f4e0c66))
* **py:** sort __all__ export list ([f1e33d6](https://github.com/theory-cloud/AppTheory/commit/f1e33d6f5e918f49b2591fcd417688dd5aea8fba))
* **release:** align branch release flow to TableTheory ([d100614](https://github.com/theory-cloud/AppTheory/commit/d10061460551952bcfc33753f1308c47bf42caed))
* **release:** align branch release flow to TableTheory ([26ba236](https://github.com/theory-cloud/AppTheory/commit/26ba236db0f9797a1ba1a590e9a52b5c02f36d11))
* **release:** ensure CDK artifacts are versioned ([8a1c12e](https://github.com/theory-cloud/AppTheory/commit/8a1c12efdb434d9b5ea930a018365606ef8fe97a))
* **release:** stop release-please PR churn ([346bb3e](https://github.com/theory-cloud/AppTheory/commit/346bb3e8f373a9331c100da0d46b4c82fc3f052d))
* **release:** support vX.Y.Z-rc tags ([6fee719](https://github.com/theory-cloud/AppTheory/commit/6fee719f90db4646182aa4983c259b0c91e9508a))
* **release:** support vX.Y.Z-rc tags ([380fd45](https://github.com/theory-cloud/AppTheory/commit/380fd450f94d9d2e09230c3404f29f08d2d0e725))
* **runtime:** address json handler lint ([b818763](https://github.com/theory-cloud/AppTheory/commit/b818763ef9994963d007d77e998afd303954516f))
* **ws:** management endpoint for custom domains ([0b2f5ad](https://github.com/theory-cloud/AppTheory/commit/0b2f5ad6aa562b0e55e49e0e2ca83bf2222b699e))
* **ws:** management endpoint for custom domains ([2ccf42b](https://github.com/theory-cloud/AppTheory/commit/2ccf42b3e581a825187422577e7331f82fc7fc2a))

## [0.8.0](https://github.com/theory-cloud/AppTheory/compare/v0.7.0...v0.8.0) (2026-02-03)


### Features

* lift compat helpers + typed JSON handler ([1244cb5](https://github.com/theory-cloud/AppTheory/commit/1244cb5b9c23aa61786274db3d6c71a2830a2aee))
* **runtime:** add typed JSON handler helper ([14d9cf6](https://github.com/theory-cloud/AppTheory/commit/14d9cf691da443f9cc6af30dce8c805dec82ac4c))
* **sanitization:** add mask helpers in ts/py ([1548c7b](https://github.com/theory-cloud/AppTheory/commit/1548c7b1e523a1213087e14e45c1029ff2a2c68f))
* **sanitization:** add MaskFirstLast helpers ([912a607](https://github.com/theory-cloud/AppTheory/commit/912a60746bc9f919f0f6eb07a377f8300fe42785))
* **zap:** accept legacy sns topic env var ([2eca449](https://github.com/theory-cloud/AppTheory/commit/2eca449f89e5e1dc9c5e9776333586d786df2b08))


### Bug Fixes

* **py:** sort __all__ export list ([f1e33d6](https://github.com/theory-cloud/AppTheory/commit/f1e33d6f5e918f49b2591fcd417688dd5aea8fba))
* **runtime:** address json handler lint ([b818763](https://github.com/theory-cloud/AppTheory/commit/b818763ef9994963d007d77e998afd303954516f))

## [0.7.0-rc.1](https://github.com/theory-cloud/AppTheory/compare/v0.7.0-rc...v0.7.0-rc.1) (2026-02-03)


### Features

* lift compat helpers + typed JSON handler ([1244cb5](https://github.com/theory-cloud/AppTheory/commit/1244cb5b9c23aa61786274db3d6c71a2830a2aee))
* **runtime:** add typed JSON handler helper ([14d9cf6](https://github.com/theory-cloud/AppTheory/commit/14d9cf691da443f9cc6af30dce8c805dec82ac4c))
* **sanitization:** add mask helpers in ts/py ([1548c7b](https://github.com/theory-cloud/AppTheory/commit/1548c7b1e523a1213087e14e45c1029ff2a2c68f))
* **sanitization:** add MaskFirstLast helpers ([912a607](https://github.com/theory-cloud/AppTheory/commit/912a60746bc9f919f0f6eb07a377f8300fe42785))
* **zap:** accept legacy sns topic env var ([2eca449](https://github.com/theory-cloud/AppTheory/commit/2eca449f89e5e1dc9c5e9776333586d786df2b08))


### Bug Fixes

* **py:** sort __all__ export list ([f1e33d6](https://github.com/theory-cloud/AppTheory/commit/f1e33d6f5e918f49b2591fcd417688dd5aea8fba))
* **runtime:** address json handler lint ([b818763](https://github.com/theory-cloud/AppTheory/commit/b818763ef9994963d007d77e998afd303954516f))

## [0.7.0](https://github.com/theory-cloud/AppTheory/compare/v0.6.0...v0.7.0) (2026-02-02)


### Features

* add global logger singleton ([d7a8996](https://github.com/theory-cloud/AppTheory/commit/d7a89965dd3316ebfc65a0b3e0b29a599b37537d))
* add portable AppTheoryError type ([340a049](https://github.com/theory-cloud/AppTheory/commit/340a049b292054b53a44f5e59ca9863b77453499))
* lift error and logger parity ([5f1185d](https://github.com/theory-cloud/AppTheory/commit/5f1185da3afc0cb70f45a2cb19eb6f00db8def84))
* serialize AppTheoryError fields in responses ([3031659](https://github.com/theory-cloud/AppTheory/commit/30316598a5b910dcecb941ad66bb67ad835b3068))

## [0.7.0-rc](https://github.com/theory-cloud/AppTheory/compare/v0.6.0...v0.7.0-rc) (2026-02-02)


### Features

* add global logger singleton ([d7a8996](https://github.com/theory-cloud/AppTheory/commit/d7a89965dd3316ebfc65a0b3e0b29a599b37537d))
* add portable AppTheoryError type ([340a049](https://github.com/theory-cloud/AppTheory/commit/340a049b292054b53a44f5e59ca9863b77453499))
* lift error and logger parity ([5f1185d](https://github.com/theory-cloud/AppTheory/commit/5f1185da3afc0cb70f45a2cb19eb6f00db8def84))
* serialize AppTheoryError fields in responses ([3031659](https://github.com/theory-cloud/AppTheory/commit/30316598a5b910dcecb941ad66bb67ad835b3068))

## [0.6.0](https://github.com/theory-cloud/AppTheory/compare/v0.5.0...v0.6.0) (2026-02-02)


### Features

* **cdk:** add DeletionProtection support to AppTheoryDynamoTable (M3) ([f81db79](https://github.com/theory-cloud/AppTheory/commit/f81db79ebf9d9f98c352e9f6a645a1f87f7fba79))
* **cdk:** close Lift CDK parity gaps (issue [#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([beec62b](https://github.com/theory-cloud/AppTheory/commit/beec62b4bbc358f01c1d9cc3207282f5ee89d348))
* **cdk:** close lift parity gaps ([#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([72d4451](https://github.com/theory-cloud/AppTheory/commit/72d44515a7cdce8d74db36f10825df13969e03b4))
* **cdk:** close lift parity gaps ([#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([2e7b719](https://github.com/theory-cloud/AppTheory/commit/2e7b719d7d07949d7b2c2543ccf1fd3f30d9c4a9))
* **cdk:** implement AppTheoryLambdaRole construct (M5) ([6eee048](https://github.com/theory-cloud/AppTheory/commit/6eee048c90e92daa1ad126050a0736d167f1e96c))
* **cdk:** implement AppTheoryMediaCdn construct (M4B) ([c87afc6](https://github.com/theory-cloud/AppTheory/commit/c87afc6a4a4e30ad05c6d2339edf2f32215824bf))
* **cdk:** implement AppTheoryPathRoutedFrontend (M4A) ([7a08876](https://github.com/theory-cloud/AppTheory/commit/7a088762985707f3871cc95244814e9e582699d7))
* **cdk:** implement AppTheoryRestApiRouter for M1 (SR-CDK-LIFT-SUNSET) ([f5eb28b](https://github.com/theory-cloud/AppTheory/commit/f5eb28b76da505005fc780661fe9080656611602))
* **cdk:** implement M2 - SQS queue + DLQ + optional consumer wiring ([8a46a88](https://github.com/theory-cloud/AppTheory/commit/8a46a88ba382596b0c5915a33b5f16bbd5b63fa5))
* **cdk:** implement M6 - Lesser parity example + migration validation gate ([038b73e](https://github.com/theory-cloud/AppTheory/commit/038b73ecb2a38c388019c12858199a219118f92b))
* Parse API origin URL to include originPath for CloudFront HttpOrigin ([e357995](https://github.com/theory-cloud/AppTheory/commit/e357995deb88bc94379fd32ab1b73d78e241440f))


### Bug Fixes

* **cdk-go:** regenerate bindings for new constructs ([ed38899](https://github.com/theory-cloud/AppTheory/commit/ed38899a22d1ad8a95cc95633e37e904ec04c238))
* **cdk-go:** regenerate bindings for new constructs ([e25ad1c](https://github.com/theory-cloud/AppTheory/commit/e25ad1c3dfb57519586331955a732c20f73e650d))
* ensure pip is installed in virtual environments and skip symlinks when setting file timestamps. ([f244777](https://github.com/theory-cloud/AppTheory/commit/f24477740e35fd75ebc6d83027943ea801e1f6d9))
* **go-lint:** deflake prerelease by removing goconst warning ([c824b9d](https://github.com/theory-cloud/AppTheory/commit/c824b9d0127e5f88257af5f078e8aab5dd087511))
* **go-lint:** unblock prerelease build ([7f640fb](https://github.com/theory-cloud/AppTheory/commit/7f640fbd8b89967d17b5d73bf8e84ed592236626))
* **release:** ensure CDK artifacts are versioned ([8a1c12e](https://github.com/theory-cloud/AppTheory/commit/8a1c12efdb434d9b5ea930a018365606ef8fe97a))
* **release:** stop release-please PR churn ([346bb3e](https://github.com/theory-cloud/AppTheory/commit/346bb3e8f373a9331c100da0d46b4c82fc3f052d))

## [0.5.0-rc.5](https://github.com/theory-cloud/AppTheory/compare/v0.5.0-rc.4...v0.5.0-rc.5) (2026-02-01)


### Features

* **cdk:** close lift parity gaps ([#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([72d4451](https://github.com/theory-cloud/AppTheory/commit/72d44515a7cdce8d74db36f10825df13969e03b4))
* **cdk:** close lift parity gaps ([#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([2e7b719](https://github.com/theory-cloud/AppTheory/commit/2e7b719d7d07949d7b2c2543ccf1fd3f30d9c4a9))

## [0.5.0-rc.4](https://github.com/theory-cloud/AppTheory/compare/v0.5.0-rc.3...v0.5.0-rc.4) (2026-02-01)


### Bug Fixes

* **cdk-go:** regenerate bindings for new constructs ([ed38899](https://github.com/theory-cloud/AppTheory/commit/ed38899a22d1ad8a95cc95633e37e904ec04c238))
* **cdk-go:** regenerate bindings for new constructs ([e25ad1c](https://github.com/theory-cloud/AppTheory/commit/e25ad1c3dfb57519586331955a732c20f73e650d))
* **release:** stop release-please PR churn ([346bb3e](https://github.com/theory-cloud/AppTheory/commit/346bb3e8f373a9331c100da0d46b4c82fc3f052d))

## [0.5.0-rc.3](https://github.com/theory-cloud/AppTheory/compare/v0.5.0-rc.2...v0.5.0-rc.3) (2026-02-01)


### Features

* **cdk:** add DeletionProtection support to AppTheoryDynamoTable (M3) ([f81db79](https://github.com/theory-cloud/AppTheory/commit/f81db79ebf9d9f98c352e9f6a645a1f87f7fba79))
* **cdk:** add DynamoTable + websocket parity ([a243db3](https://github.com/theory-cloud/AppTheory/commit/a243db3f93f5dbe29af88104a4ad38e0e0dcc381))
* **cdk:** add stream mapping tuning + ws route handlers ([756314f](https://github.com/theory-cloud/AppTheory/commit/756314f77b8fc8b8da37d14b2815d76cfc9cbf3e))
* **cdk:** close Lift CDK parity gaps (issue [#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([beec62b](https://github.com/theory-cloud/AppTheory/commit/beec62b4bbc358f01c1d9cc3207282f5ee89d348))
* **cdk:** implement AppTheoryLambdaRole construct (M5) ([6eee048](https://github.com/theory-cloud/AppTheory/commit/6eee048c90e92daa1ad126050a0736d167f1e96c))
* **cdk:** implement AppTheoryMediaCdn construct (M4B) ([c87afc6](https://github.com/theory-cloud/AppTheory/commit/c87afc6a4a4e30ad05c6d2339edf2f32215824bf))
* **cdk:** implement AppTheoryPathRoutedFrontend (M4A) ([7a08876](https://github.com/theory-cloud/AppTheory/commit/7a088762985707f3871cc95244814e9e582699d7))
* **cdk:** implement AppTheoryRestApiRouter for M1 (SR-CDK-LIFT-SUNSET) ([f5eb28b](https://github.com/theory-cloud/AppTheory/commit/f5eb28b76da505005fc780661fe9080656611602))
* **cdk:** implement M2 - SQS queue + DLQ + optional consumer wiring ([8a46a88](https://github.com/theory-cloud/AppTheory/commit/8a46a88ba382596b0c5915a33b5f16bbd5b63fa5))
* **cdk:** implement M6 - Lesser parity example + migration validation gate ([038b73e](https://github.com/theory-cloud/AppTheory/commit/038b73ecb2a38c388019c12858199a219118f92b))
* **cdk:** Lift parity (WebSocket + DynamoDB tables) ([b1b3c66](https://github.com/theory-cloud/AppTheory/commit/b1b3c6666f75d51faa7306e19f4ce306c2ffdb24))
* **cdk:** stream mapping tuning + websocket route handlers ([fd310a5](https://github.com/theory-cloud/AppTheory/commit/fd310a57cb76d028bcf8fddb8d24bb2a2c4194ef))
* Parse API origin URL to include originPath for CloudFront HttpOrigin ([e357995](https://github.com/theory-cloud/AppTheory/commit/e357995deb88bc94379fd32ab1b73d78e241440f))
* TableTheory v1.2.1 + hard drift prevention ([d89b679](https://github.com/theory-cloud/AppTheory/commit/d89b67921649b4cff7d95c69304ce8b58558f791))


### Bug Fixes

* address issue [#20](https://github.com/theory-cloud/AppTheory/issues/20) (TS batch fail-closed, strict base64, ts pack rebuild) ([99580b7](https://github.com/theory-cloud/AppTheory/commit/99580b728f2ac406093c5d2a6dd59033ff9c7692))
* address issue [#22](https://github.com/theory-cloud/AppTheory/issues/22) followups ([b1e0422](https://github.com/theory-cloud/AppTheory/commit/b1e0422b469955f8fa14e7d4efb3951f1bb84582))
* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([06f3434](https://github.com/theory-cloud/AppTheory/commit/06f3434e2a80317832f150c28b1426a844c91d31))
* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([b794697](https://github.com/theory-cloud/AppTheory/commit/b794697d5b1db95797058bb4b451c72bc5e550de))
* **cdk-go:** publish bindings via root module ([93d30a0](https://github.com/theory-cloud/AppTheory/commit/93d30a0263856723f6286f9e1df9ea88d747be4b))
* **cdk-go:** publish bindings via root module ([9646f88](https://github.com/theory-cloud/AppTheory/commit/9646f88293f530d104b7921a3994b60a831ce587))
* **cdk:** make DynamoTable TTL optional ([3c789fd](https://github.com/theory-cloud/AppTheory/commit/3c789fd1dee87f4076cbe86855c50bfcaa706f8d))
* **cdk:** make DynamoTable TTL optional ([e9b5bf1](https://github.com/theory-cloud/AppTheory/commit/e9b5bf13390eb11bac18d1285105ec3c722a8b22))
* **ci:** allow release-pr CLI ([aeb4a32](https://github.com/theory-cloud/AppTheory/commit/aeb4a32ff31d6670b5eccd8f51ca717d8cde561c))
* **ci:** auto-clean failed prerelease drafts ([4965915](https://github.com/theory-cloud/AppTheory/commit/4965915a0db4711fbe98711910b7efb107d7b2d7))
* **ci:** honor main release-as ([8c49083](https://github.com/theory-cloud/AppTheory/commit/8c4908369a4328c83e3127dfb3dd5ca71a47fbac))
* **ci:** honor main release-as ([27fe861](https://github.com/theory-cloud/AppTheory/commit/27fe861b2b204289365bc9f6d88b5472ae5e8839))
* **ci:** make jsii-pacmak compatible with -rc tags ([fd7e341](https://github.com/theory-cloud/AppTheory/commit/fd7e341a5d485b4877dcff4f77150a3db03b40c3))
* **ci:** make jsii-pacmak compatible with -rc tags ([abed83d](https://github.com/theory-cloud/AppTheory/commit/abed83d26f9c4143b3dccae3c49a89ea2e350ad8))
* **ci:** repair release-pr workflow yaml ([9ce5d80](https://github.com/theory-cloud/AppTheory/commit/9ce5d803733aeced05603df51cb6cb2a885d6ad8))
* **ci:** repair release-pr workflow yaml ([877ca72](https://github.com/theory-cloud/AppTheory/commit/877ca726c013fdecef106b643f2edbe8695db1cd))
* **ci:** run CI on staging pushes ([d218268](https://github.com/theory-cloud/AppTheory/commit/d218268f8915d8032205687306861e89d8b552fe))
* **ci:** run CI on staging pushes ([c3b6ce3](https://github.com/theory-cloud/AppTheory/commit/c3b6ce30172c827a7de02fdcd7a7cfeddcafe9c7))
* **ci:** skip branch version sync outside git repo ([24f59b4](https://github.com/theory-cloud/AppTheory/commit/24f59b4c2e2bcf9ede8739117bbbaec4f720c238))
* **ci:** skip branch version sync outside git repo ([3dd7f81](https://github.com/theory-cloud/AppTheory/commit/3dd7f81484f36a0516fa188b70fbc017faedc749))
* **ci:** support X.Y.Z-rc prerelease versions ([91c8d4c](https://github.com/theory-cloud/AppTheory/commit/91c8d4ce8290e88a18269ca1d00126dfd71190ae))
* **ci:** support X.Y.Z-rc prerelease versions ([9a6abf8](https://github.com/theory-cloud/AppTheory/commit/9a6abf881d6e292b03e46f96fff42cd33a7279d1))
* close TS fail-open + strict base64 ([4d55231](https://github.com/theory-cloud/AppTheory/commit/4d552313c5c657a604962f89e8057ea673146090))
* **contract-tests:** deflake streaming headers fixture ([042cc71](https://github.com/theory-cloud/AppTheory/commit/042cc71705fbeebf62e986292526ecf94b8a2862))
* **contract-tests:** deflake streaming headers fixture ([50a5fda](https://github.com/theory-cloud/AppTheory/commit/50a5fda3e1c2e49eda3fd8c099991d171d7becd1))
* ensure pip is installed in virtual environments and skip symlinks when setting file timestamps. ([f244777](https://github.com/theory-cloud/AppTheory/commit/f24477740e35fd75ebc6d83027943ea801e1f6d9))
* follow-ups from review (issue [#22](https://github.com/theory-cloud/AppTheory/issues/22)) ([4baa42d](https://github.com/theory-cloud/AppTheory/commit/4baa42dafc6b0f9779f2fa8f2d8fc5a9d08b266d))
* **go-lint:** deflake prerelease by removing goconst warning ([c824b9d](https://github.com/theory-cloud/AppTheory/commit/c824b9d0127e5f88257af5f078e8aab5dd087511))
* **go-lint:** unblock prerelease build ([7f640fb](https://github.com/theory-cloud/AppTheory/commit/7f640fbd8b89967d17b5d73bf8e84ed592236626))
* **release:** align branch release flow to TableTheory ([d100614](https://github.com/theory-cloud/AppTheory/commit/d10061460551952bcfc33753f1308c47bf42caed))
* **release:** align branch release flow to TableTheory ([26ba236](https://github.com/theory-cloud/AppTheory/commit/26ba236db0f9797a1ba1a590e9a52b5c02f36d11))
* **release:** ensure CDK artifacts are versioned ([8a1c12e](https://github.com/theory-cloud/AppTheory/commit/8a1c12efdb434d9b5ea930a018365606ef8fe97a))
* **release:** support vX.Y.Z-rc tags ([6fee719](https://github.com/theory-cloud/AppTheory/commit/6fee719f90db4646182aa4983c259b0c91e9508a))
* **release:** support vX.Y.Z-rc tags ([380fd45](https://github.com/theory-cloud/AppTheory/commit/380fd450f94d9d2e09230c3404f29f08d2d0e725))
* **ws:** management endpoint for custom domains ([0b2f5ad](https://github.com/theory-cloud/AppTheory/commit/0b2f5ad6aa562b0e55e49e0e2ca83bf2222b699e))
* **ws:** management endpoint for custom domains ([2ccf42b](https://github.com/theory-cloud/AppTheory/commit/2ccf42b3e581a825187422577e7331f82fc7fc2a))

## [0.5.0-rc.2](https://github.com/theory-cloud/AppTheory/compare/v0.5.0-rc.1...v0.5.0-rc.2) (2026-02-01)


### Features

* **cdk:** add DeletionProtection support to AppTheoryDynamoTable (M3) ([f81db79](https://github.com/theory-cloud/AppTheory/commit/f81db79ebf9d9f98c352e9f6a645a1f87f7fba79))
* **cdk:** close Lift CDK parity gaps (issue [#102](https://github.com/theory-cloud/AppTheory/issues/102)) ([beec62b](https://github.com/theory-cloud/AppTheory/commit/beec62b4bbc358f01c1d9cc3207282f5ee89d348))
* **cdk:** implement AppTheoryLambdaRole construct (M5) ([6eee048](https://github.com/theory-cloud/AppTheory/commit/6eee048c90e92daa1ad126050a0736d167f1e96c))
* **cdk:** implement AppTheoryMediaCdn construct (M4B) ([c87afc6](https://github.com/theory-cloud/AppTheory/commit/c87afc6a4a4e30ad05c6d2339edf2f32215824bf))
* **cdk:** implement AppTheoryPathRoutedFrontend (M4A) ([7a08876](https://github.com/theory-cloud/AppTheory/commit/7a088762985707f3871cc95244814e9e582699d7))
* **cdk:** implement AppTheoryRestApiRouter for M1 (SR-CDK-LIFT-SUNSET) ([f5eb28b](https://github.com/theory-cloud/AppTheory/commit/f5eb28b76da505005fc780661fe9080656611602))
* **cdk:** implement M2 - SQS queue + DLQ + optional consumer wiring ([8a46a88](https://github.com/theory-cloud/AppTheory/commit/8a46a88ba382596b0c5915a33b5f16bbd5b63fa5))
* **cdk:** implement M6 - Lesser parity example + migration validation gate ([038b73e](https://github.com/theory-cloud/AppTheory/commit/038b73ecb2a38c388019c12858199a219118f92b))
* Parse API origin URL to include originPath for CloudFront HttpOrigin ([e357995](https://github.com/theory-cloud/AppTheory/commit/e357995deb88bc94379fd32ab1b73d78e241440f))


### Bug Fixes

* ensure pip is installed in virtual environments and skip symlinks when setting file timestamps. ([f244777](https://github.com/theory-cloud/AppTheory/commit/f24477740e35fd75ebc6d83027943ea801e1f6d9))
* **release:** ensure CDK artifacts are versioned ([8a1c12e](https://github.com/theory-cloud/AppTheory/commit/8a1c12efdb434d9b5ea930a018365606ef8fe97a))

## [0.5.0](https://github.com/theory-cloud/AppTheory/compare/v0.4.1...v0.5.0) (2026-01-30)


### Bug Fixes

* **ci:** allow release-pr CLI ([aeb4a32](https://github.com/theory-cloud/AppTheory/commit/aeb4a32ff31d6670b5eccd8f51ca717d8cde561c))
* **ci:** auto-clean failed prerelease drafts ([4965915](https://github.com/theory-cloud/AppTheory/commit/4965915a0db4711fbe98711910b7efb107d7b2d7))
* **ci:** honor main release-as ([8c49083](https://github.com/theory-cloud/AppTheory/commit/8c4908369a4328c83e3127dfb3dd5ca71a47fbac))
* **ci:** honor main release-as ([27fe861](https://github.com/theory-cloud/AppTheory/commit/27fe861b2b204289365bc9f6d88b5472ae5e8839))
* **ci:** make jsii-pacmak compatible with -rc tags ([fd7e341](https://github.com/theory-cloud/AppTheory/commit/fd7e341a5d485b4877dcff4f77150a3db03b40c3))
* **ci:** make jsii-pacmak compatible with -rc tags ([abed83d](https://github.com/theory-cloud/AppTheory/commit/abed83d26f9c4143b3dccae3c49a89ea2e350ad8))
* **ci:** repair release-pr workflow yaml ([9ce5d80](https://github.com/theory-cloud/AppTheory/commit/9ce5d803733aeced05603df51cb6cb2a885d6ad8))
* **ci:** repair release-pr workflow yaml ([877ca72](https://github.com/theory-cloud/AppTheory/commit/877ca726c013fdecef106b643f2edbe8695db1cd))
* **ci:** run CI on staging pushes ([d218268](https://github.com/theory-cloud/AppTheory/commit/d218268f8915d8032205687306861e89d8b552fe))
* **ci:** run CI on staging pushes ([c3b6ce3](https://github.com/theory-cloud/AppTheory/commit/c3b6ce30172c827a7de02fdcd7a7cfeddcafe9c7))
* **ci:** skip branch version sync outside git repo ([24f59b4](https://github.com/theory-cloud/AppTheory/commit/24f59b4c2e2bcf9ede8739117bbbaec4f720c238))
* **ci:** skip branch version sync outside git repo ([3dd7f81](https://github.com/theory-cloud/AppTheory/commit/3dd7f81484f36a0516fa188b70fbc017faedc749))
* **ci:** support X.Y.Z-rc prerelease versions ([91c8d4c](https://github.com/theory-cloud/AppTheory/commit/91c8d4ce8290e88a18269ca1d00126dfd71190ae))
* **ci:** support X.Y.Z-rc prerelease versions ([9a6abf8](https://github.com/theory-cloud/AppTheory/commit/9a6abf881d6e292b03e46f96fff42cd33a7279d1))
* **contract-tests:** deflake streaming headers fixture ([042cc71](https://github.com/theory-cloud/AppTheory/commit/042cc71705fbeebf62e986292526ecf94b8a2862))
* **contract-tests:** deflake streaming headers fixture ([50a5fda](https://github.com/theory-cloud/AppTheory/commit/50a5fda3e1c2e49eda3fd8c099991d171d7becd1))
* **release:** align branch release flow to TableTheory ([d100614](https://github.com/theory-cloud/AppTheory/commit/d10061460551952bcfc33753f1308c47bf42caed))
* **release:** align branch release flow to TableTheory ([26ba236](https://github.com/theory-cloud/AppTheory/commit/26ba236db0f9797a1ba1a590e9a52b5c02f36d11))
* **release:** support vX.Y.Z-rc tags ([6fee719](https://github.com/theory-cloud/AppTheory/commit/6fee719f90db4646182aa4983c259b0c91e9508a))
* **release:** support vX.Y.Z-rc tags ([380fd45](https://github.com/theory-cloud/AppTheory/commit/380fd450f94d9d2e09230c3404f29f08d2d0e725))

## [0.5.0-rc.1](https://github.com/theory-cloud/AppTheory/compare/v0.5.0-rc...v0.5.0-rc.1) (2026-01-30)


### Bug Fixes

* **ci:** allow release-pr CLI ([aeb4a32](https://github.com/theory-cloud/AppTheory/commit/aeb4a32ff31d6670b5eccd8f51ca717d8cde561c))
* **ci:** honor main release-as ([8c49083](https://github.com/theory-cloud/AppTheory/commit/8c4908369a4328c83e3127dfb3dd5ca71a47fbac))
* **ci:** honor main release-as ([27fe861](https://github.com/theory-cloud/AppTheory/commit/27fe861b2b204289365bc9f6d88b5472ae5e8839))
* **contract-tests:** deflake streaming headers fixture ([042cc71](https://github.com/theory-cloud/AppTheory/commit/042cc71705fbeebf62e986292526ecf94b8a2862))
* **contract-tests:** deflake streaming headers fixture ([50a5fda](https://github.com/theory-cloud/AppTheory/commit/50a5fda3e1c2e49eda3fd8c099991d171d7becd1))

## [0.5.0-rc](https://github.com/theory-cloud/AppTheory/compare/v0.4.2-rc...v0.5.0-rc) (2026-01-30)


### Features

* **cdk:** add DynamoTable + websocket parity ([a243db3](https://github.com/theory-cloud/AppTheory/commit/a243db3f93f5dbe29af88104a4ad38e0e0dcc381))
* **cdk:** add stream mapping tuning + ws route handlers ([756314f](https://github.com/theory-cloud/AppTheory/commit/756314f77b8fc8b8da37d14b2815d76cfc9cbf3e))
* **cdk:** Lift parity (WebSocket + DynamoDB tables) ([b1b3c66](https://github.com/theory-cloud/AppTheory/commit/b1b3c6666f75d51faa7306e19f4ce306c2ffdb24))
* **cdk:** stream mapping tuning + websocket route handlers ([fd310a5](https://github.com/theory-cloud/AppTheory/commit/fd310a57cb76d028bcf8fddb8d24bb2a2c4194ef))
* TableTheory v1.2.1 + hard drift prevention ([d89b679](https://github.com/theory-cloud/AppTheory/commit/d89b67921649b4cff7d95c69304ce8b58558f791))


### Bug Fixes

* address issue [#20](https://github.com/theory-cloud/AppTheory/issues/20) (TS batch fail-closed, strict base64, ts pack rebuild) ([99580b7](https://github.com/theory-cloud/AppTheory/commit/99580b728f2ac406093c5d2a6dd59033ff9c7692))
* address issue [#22](https://github.com/theory-cloud/AppTheory/issues/22) followups ([b1e0422](https://github.com/theory-cloud/AppTheory/commit/b1e0422b469955f8fa14e7d4efb3951f1bb84582))
* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([06f3434](https://github.com/theory-cloud/AppTheory/commit/06f3434e2a80317832f150c28b1426a844c91d31))
* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([b794697](https://github.com/theory-cloud/AppTheory/commit/b794697d5b1db95797058bb4b451c72bc5e550de))
* **cdk-go:** publish bindings via root module ([93d30a0](https://github.com/theory-cloud/AppTheory/commit/93d30a0263856723f6286f9e1df9ea88d747be4b))
* **cdk-go:** publish bindings via root module ([9646f88](https://github.com/theory-cloud/AppTheory/commit/9646f88293f530d104b7921a3994b60a831ce587))
* **cdk:** make DynamoTable TTL optional ([3c789fd](https://github.com/theory-cloud/AppTheory/commit/3c789fd1dee87f4076cbe86855c50bfcaa706f8d))
* **cdk:** make DynamoTable TTL optional ([e9b5bf1](https://github.com/theory-cloud/AppTheory/commit/e9b5bf13390eb11bac18d1285105ec3c722a8b22))
* **ci:** auto-clean failed prerelease drafts ([4965915](https://github.com/theory-cloud/AppTheory/commit/4965915a0db4711fbe98711910b7efb107d7b2d7))
* **ci:** make jsii-pacmak compatible with -rc tags ([fd7e341](https://github.com/theory-cloud/AppTheory/commit/fd7e341a5d485b4877dcff4f77150a3db03b40c3))
* **ci:** make jsii-pacmak compatible with -rc tags ([abed83d](https://github.com/theory-cloud/AppTheory/commit/abed83d26f9c4143b3dccae3c49a89ea2e350ad8))
* **ci:** repair release-pr workflow yaml ([9ce5d80](https://github.com/theory-cloud/AppTheory/commit/9ce5d803733aeced05603df51cb6cb2a885d6ad8))
* **ci:** repair release-pr workflow yaml ([877ca72](https://github.com/theory-cloud/AppTheory/commit/877ca726c013fdecef106b643f2edbe8695db1cd))
* **ci:** run CI on staging pushes ([d218268](https://github.com/theory-cloud/AppTheory/commit/d218268f8915d8032205687306861e89d8b552fe))
* **ci:** run CI on staging pushes ([c3b6ce3](https://github.com/theory-cloud/AppTheory/commit/c3b6ce30172c827a7de02fdcd7a7cfeddcafe9c7))
* **ci:** skip branch version sync outside git repo ([24f59b4](https://github.com/theory-cloud/AppTheory/commit/24f59b4c2e2bcf9ede8739117bbbaec4f720c238))
* **ci:** skip branch version sync outside git repo ([3dd7f81](https://github.com/theory-cloud/AppTheory/commit/3dd7f81484f36a0516fa188b70fbc017faedc749))
* **ci:** support X.Y.Z-rc prerelease versions ([91c8d4c](https://github.com/theory-cloud/AppTheory/commit/91c8d4ce8290e88a18269ca1d00126dfd71190ae))
* **ci:** support X.Y.Z-rc prerelease versions ([9a6abf8](https://github.com/theory-cloud/AppTheory/commit/9a6abf881d6e292b03e46f96fff42cd33a7279d1))
* close TS fail-open + strict base64 ([4d55231](https://github.com/theory-cloud/AppTheory/commit/4d552313c5c657a604962f89e8057ea673146090))
* follow-ups from review (issue [#22](https://github.com/theory-cloud/AppTheory/issues/22)) ([4baa42d](https://github.com/theory-cloud/AppTheory/commit/4baa42dafc6b0f9779f2fa8f2d8fc5a9d08b266d))
* **release:** align branch release flow to TableTheory ([d100614](https://github.com/theory-cloud/AppTheory/commit/d10061460551952bcfc33753f1308c47bf42caed))
* **release:** align branch release flow to TableTheory ([26ba236](https://github.com/theory-cloud/AppTheory/commit/26ba236db0f9797a1ba1a590e9a52b5c02f36d11))
* **release:** support vX.Y.Z-rc tags ([6fee719](https://github.com/theory-cloud/AppTheory/commit/6fee719f90db4646182aa4983c259b0c91e9508a))
* **release:** support vX.Y.Z-rc tags ([380fd45](https://github.com/theory-cloud/AppTheory/commit/380fd450f94d9d2e09230c3404f29f08d2d0e725))
* **ws:** management endpoint for custom domains ([0b2f5ad](https://github.com/theory-cloud/AppTheory/commit/0b2f5ad6aa562b0e55e49e0e2ca83bf2222b699e))
* **ws:** management endpoint for custom domains ([2ccf42b](https://github.com/theory-cloud/AppTheory/commit/2ccf42b3e581a825187422577e7331f82fc7fc2a))

## [0.4.2-rc](https://github.com/theory-cloud/AppTheory/compare/v0.4.1...v0.4.2-rc) (2026-01-30)


### Bug Fixes

* **ci:** skip branch version sync outside git repo ([24f59b4](https://github.com/theory-cloud/AppTheory/commit/24f59b4c2e2bcf9ede8739117bbbaec4f720c238))
* **ci:** skip branch version sync outside git repo ([3dd7f81](https://github.com/theory-cloud/AppTheory/commit/3dd7f81484f36a0516fa188b70fbc017faedc749))
* **release:** align branch release flow to TableTheory ([d100614](https://github.com/theory-cloud/AppTheory/commit/d10061460551952bcfc33753f1308c47bf42caed))
* **release:** align branch release flow to TableTheory ([26ba236](https://github.com/theory-cloud/AppTheory/commit/26ba236db0f9797a1ba1a590e9a52b5c02f36d11))

## [0.4.1](https://github.com/theory-cloud/AppTheory/compare/v0.4.0...v0.4.1) (2026-01-25)


### Bug Fixes

* **ws:** management endpoint for custom domains ([0b2f5ad](https://github.com/theory-cloud/AppTheory/commit/0b2f5ad6aa562b0e55e49e0e2ca83bf2222b699e))
* **ws:** management endpoint for custom domains ([2ccf42b](https://github.com/theory-cloud/AppTheory/commit/2ccf42b3e581a825187422577e7331f82fc7fc2a))

## [0.2.0-rc.10](https://github.com/theory-cloud/AppTheory/compare/v0.2.0-rc.9...v0.2.0-rc.10) (2026-01-25)


### Bug Fixes

* **ws:** management endpoint for custom domains ([0b2f5ad](https://github.com/theory-cloud/AppTheory/commit/0b2f5ad6aa562b0e55e49e0e2ca83bf2222b699e))
* **ws:** management endpoint for custom domains ([2ccf42b](https://github.com/theory-cloud/AppTheory/commit/2ccf42b3e581a825187422577e7331f82fc7fc2a))

## [0.4.0](https://github.com/theory-cloud/AppTheory/compare/v0.3.1...v0.4.0) (2026-01-24)


### Features

* **cdk:** add stream mapping tuning + ws route handlers ([756314f](https://github.com/theory-cloud/AppTheory/commit/756314f77b8fc8b8da37d14b2815d76cfc9cbf3e))
* **cdk:** stream mapping tuning + websocket route handlers ([fd310a5](https://github.com/theory-cloud/AppTheory/commit/fd310a57cb76d028bcf8fddb8d24bb2a2c4194ef))

## [0.2.0-rc.9](https://github.com/theory-cloud/AppTheory/compare/v0.2.0-rc.8...v0.2.0-rc.9) (2026-01-24)


### Features

* **cdk:** add stream mapping tuning + ws route handlers ([756314f](https://github.com/theory-cloud/AppTheory/commit/756314f77b8fc8b8da37d14b2815d76cfc9cbf3e))
* **cdk:** stream mapping tuning + websocket route handlers ([fd310a5](https://github.com/theory-cloud/AppTheory/commit/fd310a57cb76d028bcf8fddb8d24bb2a2c4194ef))

## [0.3.1](https://github.com/theory-cloud/AppTheory/compare/v0.3.0...v0.3.1) (2026-01-24)


### Bug Fixes

* **cdk:** make DynamoTable TTL optional ([3c789fd](https://github.com/theory-cloud/AppTheory/commit/3c789fd1dee87f4076cbe86855c50bfcaa706f8d))
* **cdk:** make DynamoTable TTL optional ([e9b5bf1](https://github.com/theory-cloud/AppTheory/commit/e9b5bf13390eb11bac18d1285105ec3c722a8b22))

## [0.2.0-rc.8](https://github.com/theory-cloud/AppTheory/compare/v0.2.0-rc.7...v0.2.0-rc.8) (2026-01-24)


### Bug Fixes

* **cdk:** make DynamoTable TTL optional ([3c789fd](https://github.com/theory-cloud/AppTheory/commit/3c789fd1dee87f4076cbe86855c50bfcaa706f8d))
* **cdk:** make DynamoTable TTL optional ([e9b5bf1](https://github.com/theory-cloud/AppTheory/commit/e9b5bf13390eb11bac18d1285105ec3c722a8b22))

## [0.3.0](https://github.com/theory-cloud/AppTheory/compare/v0.2.1...v0.3.0) (2026-01-23)


### Features

* **cdk:** add DynamoTable + websocket parity ([a243db3](https://github.com/theory-cloud/AppTheory/commit/a243db3f93f5dbe29af88104a4ad38e0e0dcc381))
* **cdk:** Lift parity (WebSocket + DynamoDB tables) ([b1b3c66](https://github.com/theory-cloud/AppTheory/commit/b1b3c6666f75d51faa7306e19f4ce306c2ffdb24))

## [0.2.0-rc.7](https://github.com/theory-cloud/AppTheory/compare/v0.2.0-rc.6...v0.2.0-rc.7) (2026-01-23)


### Features

* **cdk:** add DynamoTable + websocket parity ([a243db3](https://github.com/theory-cloud/AppTheory/commit/a243db3f93f5dbe29af88104a4ad38e0e0dcc381))
* **cdk:** Lift parity (WebSocket + DynamoDB tables) ([b1b3c66](https://github.com/theory-cloud/AppTheory/commit/b1b3c6666f75d51faa7306e19f4ce306c2ffdb24))

## [0.2.1](https://github.com/theory-cloud/AppTheory/compare/v0.2.0...v0.2.1) (2026-01-23)


### Bug Fixes

* **cdk-go:** publish bindings via root module ([93d30a0](https://github.com/theory-cloud/AppTheory/commit/93d30a0263856723f6286f9e1df9ea88d747be4b))
* **cdk-go:** publish bindings via root module ([9646f88](https://github.com/theory-cloud/AppTheory/commit/9646f88293f530d104b7921a3994b60a831ce587))

## [0.2.0](https://github.com/theory-cloud/AppTheory/compare/v0.1.0...v0.2.0) (2026-01-23)


### Features

* **cdk:** add EventBusTable construct ([4087579](https://github.com/theory-cloud/AppTheory/commit/4087579ad99e5e481b7714046939a547039483bb))
* **middleware:** add event trigger middleware + EventContext bag ([a2aec04](https://github.com/theory-cloud/AppTheory/commit/a2aec04569f5c5963838c927ceccd3e7c54a4355))
* **middleware:** add global pipeline + ctx bag ([02cfab7](https://github.com/theory-cloud/AppTheory/commit/02cfab7d7c103d51cd95c4c20d21b28c88f19f28))
* **naming:** add deterministic naming helpers ([6cd8950](https://github.com/theory-cloud/AppTheory/commit/6cd895001534acfdf396b0d1ba91da43763b1b10))
* **observability:** add structured logger + zap integration ([e30131e](https://github.com/theory-cloud/AppTheory/commit/e30131e238c4984c2ee1575530f561185cd8d9a6))
* **sanitization:** add safe logging helpers ([52e3636](https://github.com/theory-cloud/AppTheory/commit/52e363697e6a56c83498277c024e3aca9872476c))
* **services:** add TableTheory-backed EventBus ([fae9c76](https://github.com/theory-cloud/AppTheory/commit/fae9c7643a0b748ae2c5ec4a02de0dfa7058c510))
* **sse:** add event-by-event streaming ([1afa9bb](https://github.com/theory-cloud/AppTheory/commit/1afa9bbf136bda119ef22c370dd0f4c23b58cefd))
* TableTheory v1.2.1 + hard drift prevention ([d89b679](https://github.com/theory-cloud/AppTheory/commit/d89b67921649b4cff7d95c69304ce8b58558f791))
* **websockets:** add CDK WebSocket API ([984347a](https://github.com/theory-cloud/AppTheory/commit/984347a50b130f8aebb0b4384a5c46e6904b3a8b))


### Bug Fixes

* address issue [#20](https://github.com/theory-cloud/AppTheory/issues/20) (TS batch fail-closed, strict base64, ts pack rebuild) ([99580b7](https://github.com/theory-cloud/AppTheory/commit/99580b728f2ac406093c5d2a6dd59033ff9c7692))
* address issue [#22](https://github.com/theory-cloud/AppTheory/issues/22) followups ([b1e0422](https://github.com/theory-cloud/AppTheory/commit/b1e0422b469955f8fa14e7d4efb3951f1bb84582))
* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([06f3434](https://github.com/theory-cloud/AppTheory/commit/06f3434e2a80317832f150c28b1426a844c91d31))
* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([b794697](https://github.com/theory-cloud/AppTheory/commit/b794697d5b1db95797058bb4b451c72bc5e550de))
* **ci:** gofmt and lint cleanups ([56a2a3f](https://github.com/theory-cloud/AppTheory/commit/56a2a3f9c37ffe63201a57ab663b831aedae3779))
* close TS fail-open + strict base64 ([4d55231](https://github.com/theory-cloud/AppTheory/commit/4d552313c5c657a604962f89e8057ea673146090))
* follow-ups from review (issue [#22](https://github.com/theory-cloud/AppTheory/issues/22)) ([4baa42d](https://github.com/theory-cloud/AppTheory/commit/4baa42dafc6b0f9779f2fa8f2d8fc5a9d08b266d))

## [0.2.0-rc.5](https://github.com/theory-cloud/AppTheory/compare/v0.2.0-rc.4...v0.2.0-rc.5) (2026-01-23)


### Features

* TableTheory v1.2.1 + hard drift prevention ([d89b679](https://github.com/theory-cloud/AppTheory/commit/d89b67921649b4cff7d95c69304ce8b58558f791))

## [0.2.0-rc.4](https://github.com/theory-cloud/AppTheory/compare/v0.2.0-rc.3...v0.2.0-rc.4) (2026-01-23)


### Bug Fixes

* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([06f3434](https://github.com/theory-cloud/AppTheory/commit/06f3434e2a80317832f150c28b1426a844c91d31))
* address issue [#27](https://github.com/theory-cloud/AppTheory/issues/27) parity ([b794697](https://github.com/theory-cloud/AppTheory/commit/b794697d5b1db95797058bb4b451c72bc5e550de))

## [0.2.0-rc.3](https://github.com/theory-cloud/AppTheory/compare/v0.2.0-rc.2...v0.2.0-rc.3) (2026-01-22)


### Bug Fixes

* address issue [#20](https://github.com/theory-cloud/AppTheory/issues/20) (TS batch fail-closed, strict base64, ts pack rebuild) ([99580b7](https://github.com/theory-cloud/AppTheory/commit/99580b728f2ac406093c5d2a6dd59033ff9c7692))
* address issue [#22](https://github.com/theory-cloud/AppTheory/issues/22) followups ([b1e0422](https://github.com/theory-cloud/AppTheory/commit/b1e0422b469955f8fa14e7d4efb3951f1bb84582))
* close TS fail-open + strict base64 ([4d55231](https://github.com/theory-cloud/AppTheory/commit/4d552313c5c657a604962f89e8057ea673146090))
* follow-ups from review (issue [#22](https://github.com/theory-cloud/AppTheory/issues/22)) ([4baa42d](https://github.com/theory-cloud/AppTheory/commit/4baa42dafc6b0f9779f2fa8f2d8fc5a9d08b266d))
