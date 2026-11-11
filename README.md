# DataHarbor 数据产品交付

管理机构、表结构、不可变数据版本、授权、申请审批和可撤回交付。表格导入支持质量门禁；数据派生保留依赖关系，授权撤回会传递到交付读取。除行级交付外，还支持小样本保护的聚合统计交付：按授权先过滤、按主体键去重计数，并对敏感切片做互补抑制。

## 交付模式

- **行级交付（row）**：沿用既有披露规则，对放行列做脱敏/泛化与等价组小样本抑制。
- **聚合交付（aggregate）**：申请时选择分组维度、主体键和计数/数值汇总（count、sum、mean、min、max）。系统先按机构授权与过滤条件筛选，再按主体键去重；主体为空的行不计入，同一主体多行只计一次，数值汇总仍覆盖该主体的全部行。

聚合申请需要授权的小样本门槛（minimumGroup ≥ 2）。生成立方体时，对每个不足门槛的切片先做主抑制，再对其行列小计与总计执行互补抑制，保证任何已发布的上级单元都无法通过相减还原出唯一的小单元。输出单元以 `state` 明确区分 `published`、`zero`（确为零）、`no_records`（无记录）和 `suppressed`（已抑制），抑制原因（small_sample / complementary）写入清单与证明，但不包含任何真实人数。

聚合申请与成品会锁定字段、数据对象、schema 与授权口径版本（inputHash、outputHash、aggregateHash、policyHash、schemaHash、versionObject）。生成交付时重新校验审批法定人数、审批绑定的输出哈希、授权状态与撤权；授权撤回或机构停用后，下载与证明立即失效。聚合交付只消耗交付次数额度，不占用行预算，行级交付保持原有行为不变。

聚合请求与普通请求共用 `request`、`decide`、`release`、`fetch`、`proof` 命令与同名 HTTP 接口，仅在请求体中增加 `"mode": "aggregate"` 与 `aggregate` 规格：

```json
{
  "mode": "aggregate",
  "aggregate": {
    "groupBy": ["age_band", "district"],
    "subjectKey": "person",
    "measures": [
      {"name": "users", "operation": "count"},
      {"name": "hours_total", "operation": "sum", "source": "hours"}
    ],
    "totals": true,
    "maximumCells": 5000
  }
}
```

`totals` 取 `true`（全部行列小计与总计）、`false`（仅叶子单元）或维度子集清单；立方体单元数超过 `maximumCells` 会被拒绝，以限制可组合发布范围。

## 运行环境

使用 Node.js 22，核心功能依赖标准库。演示和测试只使用本地合成数据，不需要账户、设备或外部运行服务。请从项目根目录执行命令。

## 检查与运行

构建检查验证语法，测试使用临时数据目录，不会连接远端服务。

```sh
npm run build
npm test
npm run acceptance
```

演示会展示产品的实际数据处理和输出，运行结束自行退出。查看现有接口：

```sh
node src/main.js help
```

## 目录与数据

src/ 保存领域逻辑和请求入口，tests/ 包含正常行为、边界与恢复测试。例子中的标识和记录为合成资料，不包含真实人员或生产测量。业务目录和本地数据库由调用者指定，应与源码分开保存。

## 干净环境复现

容器定义固定运行时版本。构建时准备环境，运行时无需网络；每次启动会复制只读源码到临时工作目录，测试产生的文件不会写回仓库。

```sh
docker build -t local-product-check .
docker run --rm --network none local-product-check
```
