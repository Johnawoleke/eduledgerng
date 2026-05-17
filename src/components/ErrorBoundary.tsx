import React, { ReactNode, ErrorInfo } from "react";
import { AlertCircle, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary to catch rendering exceptions and display a user-friendly error page
 * instead of a blank white screen. Provides recovery options.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center px-4">
          <div className="max-w-md w-full space-y-6 text-center">
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertCircle className="w-8 h-8 text-destructive" />
              </div>
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-bold">Something went wrong</h1>
              <p className="text-muted-foreground text-sm">
                We encountered an unexpected error rendering this page. Please try refreshing or return to the home page.
              </p>
            </div>
            {process.env.NODE_ENV === "development" && this.state.error && (
              <div className="bg-muted p-3 rounded-lg text-left text-xs font-mono text-destructive overflow-auto max-h-32">
                {this.state.error.message}
              </div>
            )}
            <Button onClick={this.handleReset} className="w-full gap-2">
              <Home className="w-4 h-4" /> Return to Home
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
