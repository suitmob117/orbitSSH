import type { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, SelectHTMLAttributes } from 'react';
import { cn } from '@renderer/lib/utils';

export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      className={cn(
        'group relative inline-flex h-9 items-center justify-center gap-2 overflow-hidden rounded-lg px-4 text-sm font-medium text-primary-foreground transition-all duration-200',
        'bg-gradient-to-b from-primary to-primary/85 shadow-glow-sm',
        'hover:shadow-glow hover:brightness-105 active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:brightness-100',
        className
      )}
      {...props}
    />
  );
}

export function SecondaryButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground/90 transition-all duration-200',
        'hover:border-primary/40 hover:bg-muted hover:text-foreground active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-card',
        className
      )}
      {...props}
    />
  );
}

export function DangerButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 text-sm font-medium text-destructive transition-all duration-200',
        'hover:border-destructive hover:bg-destructive hover:text-destructive-foreground active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-destructive/10 disabled:hover:text-destructive',
        className
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-all duration-200',
        'placeholder:text-muted-foreground/60',
        'hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return (
    <select
      className={cn(
        'h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-all duration-200',
        'hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/20',
        'disabled:cursor-not-allowed disabled:opacity-50 [&>option]:bg-card [&>option]:text-foreground',
        className
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>): JSX.Element {
  return (
    <label
      className={cn('text-[11px] font-medium uppercase tracking-wider text-muted-foreground', className)}
      {...props}
    />
  );
}

export function Badge({
  children,
  tone = 'neutral'
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red';
}): JSX.Element {
  const tones = {
    neutral: 'border-border bg-muted text-muted-foreground',
    green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300',
    red: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
  };
  const dot = {
    neutral: 'bg-muted-foreground/50',
    green: 'bg-emerald-500 animate-pulse-glow',
    amber: 'bg-amber-500',
    red: 'bg-red-500'
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide',
        tones[tone]
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot[tone])} />
      {children}
    </span>
  );
}
