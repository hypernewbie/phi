" Phi Lime Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_lime"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#a3e635 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#a3e635
hi IncSearch        guifg=#14141a guibg=#84cc16
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#a3e635 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#a3e635 guibg=#1f1f26  gui=bold
hi Directory        guifg=#84cc16

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#a3e635
hi String           guifg=#d9f99d
hi Character        guifg=#d9f99d
hi Number           guifg=#a3e635
hi Boolean          guifg=#a3e635
hi Float            guifg=#a3e635

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#84cc16

hi Statement        guifg=#a3e635 gui=bold
hi Conditional      guifg=#a3e635 gui=bold
hi Repeat           guifg=#a3e635 gui=bold
hi Label            guifg=#a3e635
hi Operator         guifg=#84cc16
hi Keyword          guifg=#a3e635 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#4d7c0f
hi Include          guifg=#4d7c0f
hi Define           guifg=#4d7c0f
hi Macro            guifg=#4d7c0f
hi PreCondit        guifg=#4d7c0f

hi Type             guifg=#4d7c0f gui=bold
hi StorageClass     guifg=#4d7c0f
hi Structure        guifg=#4d7c0f
hi Typedef          guifg=#4d7c0f

hi Special          guifg=#a3e635
hi SpecialChar      guifg=#d9f99d
hi Tag              guifg=#84cc16
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#84cc16    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#a3e635  guibg=#1f1f26  gui=bold
