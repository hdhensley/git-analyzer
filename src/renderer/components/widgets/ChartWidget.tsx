import { Component, ErrorInfo, ReactNode, useState } from 'react';
import type { ChartWidgetProps, ChartWidgetDefinition } from './types';
import './ChartWidget.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  widgetName: string;
  onError: (error: Error) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class WidgetErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`Widget error in ${this.props.widgetName}:`, error, errorInfo);
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="chart-widget__error">
          <span className="chart-widget__error-icon">⚠️</span>
          <span>Failed to render widget: {this.state.error?.message}</span>
        </div>
      );
    }

    return this.props.children;
  }
}

interface ChartWidgetWrapperProps extends ChartWidgetProps {
  definition: ChartWidgetDefinition;
}

export function ChartWidget({ definition, commits, dateRange, selectedRepoIds, onError }: ChartWidgetWrapperProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const WidgetComponent = definition.component;

  // Pass commits directly - widgets declare their required fields for documentation
  // but receive full commit objects for flexibility
  return (
    <div className={`chart-widget ${isCollapsed ? 'chart-widget--collapsed' : ''}`}>
      <div className="chart-widget__header">
        <div className="chart-widget__header-content">
          <h3 className="chart-widget__title">{definition.name}</h3>
          <p className="chart-widget__description">{definition.description}</p>
        </div>
        <button
          type="button"
          className="chart-widget__collapse-btn"
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-label={isCollapsed ? 'Expand widget' : 'Collapse widget'}
          title={isCollapsed ? 'Expand' : 'Collapse'}
        >
          {isCollapsed ? '▼' : '▲'}
        </button>
      </div>
      {!isCollapsed && (
        <div className="chart-widget__content">
          <WidgetErrorBoundary widgetName={definition.name} onError={onError}>
            <WidgetComponent
              commits={commits}
              dateRange={dateRange}
              selectedRepoIds={selectedRepoIds}
              onError={onError}
            />
          </WidgetErrorBoundary>
        </div>
      )}
    </div>
  );
}
