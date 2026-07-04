package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2"
)

type AppTheoryObservabilityProps struct {
	// Optional dimension filters for alarm Metrics Insights queries.
	//
	// The runtime emits only the full AppTheory EMF dimension set, so default
	// alarms use Metrics Insights over that schema instead of service-only
	// CloudWatch metric dimensions.
	//
	// Dashboard search widgets also use the full AppTheory EMF schema.
	// Default: { service: serviceName }.
	//
	AlarmDimensions *AppTheoryRequestMetricDimensions `field:"optional" json:"alarmDimensions" yaml:"alarmDimensions"`
	// Whether to create the dashboard.
	// Default: true.
	//
	CreateDashboard *bool `field:"optional" json:"createDashboard" yaml:"createDashboard"`
	// Dashboard name.
	// Default: undefined.
	//
	DashboardName *string `field:"optional" json:"dashboardName" yaml:"dashboardName"`
	// Alarm evaluation periods.
	// Default: 1.
	//
	EvaluationPeriods *float64 `field:"optional" json:"evaluationPeriods" yaml:"evaluationPeriods"`
	// CloudWatch metric namespace emitted by AppTheory EMF sinks.
	// Default: "AppTheory".
	//
	MetricNamespace *string `field:"optional" json:"metricNamespace" yaml:"metricNamespace"`
	// Metric period.
	// Default: Duration.minutes(5)
	//
	Period awscdk.Duration `field:"optional" json:"period" yaml:"period"`
	// Request duration alarm threshold in milliseconds.
	// Default: 1000.
	//
	RequestDurationThresholdMs *float64 `field:"optional" json:"requestDurationThresholdMs" yaml:"requestDurationThresholdMs"`
	// Request error alarm threshold over the period.
	// Default: 1.
	//
	RequestErrorThreshold *float64 `field:"optional" json:"requestErrorThreshold" yaml:"requestErrorThreshold"`
	// Service dimension emitted by the runtime.
	// Default: "apptheory".
	//
	ServiceName *string `field:"optional" json:"serviceName" yaml:"serviceName"`
}
