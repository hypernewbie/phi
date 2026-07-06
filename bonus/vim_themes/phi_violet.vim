" Phi Violet Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_violet"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#ddd6fe gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#ddd6fe
hi IncSearch        guifg=#14141a guibg=#a78bfa
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#ddd6fe guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#ddd6fe guibg=#1f1f26  gui=bold
hi Directory        guifg=#a78bfa

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#ddd6fe
hi String           guifg=#ede9fe
hi Character        guifg=#ede9fe
hi Number           guifg=#ddd6fe
hi Boolean          guifg=#ddd6fe
hi Float            guifg=#ddd6fe

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#a78bfa

hi Statement        guifg=#ddd6fe gui=bold
hi Conditional      guifg=#ddd6fe gui=bold
hi Repeat           guifg=#ddd6fe gui=bold
hi Label            guifg=#ddd6fe
hi Operator         guifg=#a78bfa
hi Keyword          guifg=#ddd6fe gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#6d28d9
hi Include          guifg=#6d28d9
hi Define           guifg=#6d28d9
hi Macro            guifg=#6d28d9
hi PreCondit        guifg=#6d28d9

hi Type             guifg=#6d28d9 gui=bold
hi StorageClass     guifg=#6d28d9
hi Structure        guifg=#6d28d9
hi Typedef          guifg=#6d28d9

hi Special          guifg=#ddd6fe
hi SpecialChar      guifg=#ede9fe
hi Tag              guifg=#a78bfa
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#a78bfa    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#ddd6fe  guibg=#1f1f26  gui=bold
