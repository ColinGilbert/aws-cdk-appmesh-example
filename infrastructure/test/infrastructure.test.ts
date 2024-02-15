import { Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import * as Infrastructure from "../lib/infrastructure-stack";

test("Empty Stack", () => {
  const app = new cdk.App();
  // WHEN
  const stack = new Infrastructure.InfrastructureStack(app, "MyTestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  // THEN
  const template = Template.fromStack(stack);
  expect(template.toJSON()).toMatchSnapshot();
});
