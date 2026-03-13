/**
 * @description: Restores the legacy global JSX namespace so existing component typings keep working with React 19 type packages.
 * @footnote-scope: web
 * @footnote-module: ReactJsxCompatTypes
 * @footnote-risk: low - Incorrect JSX aliases would surface as TypeScript errors in the web package.
 * @footnote-ethics: low - This file only adapts compile-time types and does not affect user-facing runtime behavior.
 */

import type * as React from 'react';

declare global {
    namespace JSX {
        interface Element extends React.JSX.Element {}
        interface ElementClass extends React.JSX.ElementClass {}
        interface ElementAttributesProperty
            extends React.JSX.ElementAttributesProperty {}
        interface ElementChildrenAttribute
            extends React.JSX.ElementChildrenAttribute {}
        type LibraryManagedAttributes<C, P> =
            React.JSX.LibraryManagedAttributes<C, P>;
        interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
        interface IntrinsicClassAttributes<T>
            extends React.JSX.IntrinsicClassAttributes<T> {}
        interface IntrinsicElements extends React.JSX.IntrinsicElements {}
    }
}

export {};
